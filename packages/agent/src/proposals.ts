/**
 * Proposal lifecycle: create -> apply selected (atomic) -> undo all.
 *
 * Applying is one SQLite immediate transaction. Any stale per-task revision,
 * expired proposal, bad payload hash, or invalid operation rolls the whole
 * batch back. The applied batch ID is derived from the first activity row so
 * undo can replay the before/after snapshots in reverse.
 */
import { newId, nowIso } from "@morrow/shared";
import {
  AgentError,
  type ProposalOperation,
  type ProposalRecord,
  type TaskView,
} from "./types.js";
import {
  previewOperations,
  validateOperations,
} from "./policy.js";
import { parseOperations, TaskStore } from "./store.js";
import { hashPayload } from "./util.js";

interface ActivityEnvelope {
  task: Record<string, unknown> | null;
  completion: Record<string, unknown> | null;
}

export interface ApplyProposalOptions {
  selectedIndexes?: number[];
  selectedOperationIds?: string[];
  payloadHash?: string;
  baseRev?: number;
  actorId: string;
}

export interface ApplyProposalResult {
  proposal: ProposalRecord;
  applied: number;
  batchId: string;
  activityIds: number[];
  appliedRev: number;
}

function proposalExpiry(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function attachPreview(proposal: ProposalRecord): ProposalRecord {
  return { ...proposal, preview: previewOperations(proposal.operations) };
}

export function createProposal(
  store: TaskStore,
  input: {
    conversationId: string | null;
    summary: string;
    operations: ProposalOperation[];
  },
): ProposalRecord {
  validateOperations(input.operations);
  const summary = input.summary.trim().slice(0, 500) || "Suggested changes";
  const proposal = store.createProposal({
    conversationId: input.conversationId,
    summary,
    operations: input.operations,
    baseRev: store.currentMaxRev(),
    expiresAt: proposalExpiry(),
  });
  return attachPreview(proposal);
}

export function getProposalWithPreview(
  store: TaskStore,
  id: string,
): ProposalRecord | null {
  const proposal = store.getProposal(id);
  return proposal ? attachPreview(proposal) : null;
}

export function listProposalsWithPreview(
  store: TaskStore,
  opts: { status?: string; conversationId?: string; limit?: number } = {},
): ProposalRecord[] {
  return store
    .listProposals(opts)
    .map((proposal) => attachPreview(proposal));
}

function selectOperations(
  operations: ProposalOperation[],
  options: ApplyProposalOptions,
): Array<{ operation: ProposalOperation; index: number }> {
  if (options.selectedOperationIds && options.selectedOperationIds.length > 0) {
    const wanted = new Set(options.selectedOperationIds);
    return operations
      .map((operation, index) => ({ operation, index }))
      .filter(({ operation }) => wanted.has(operation.operationId));
  }
  if (options.selectedIndexes && options.selectedIndexes.length > 0) {
    const wanted = new Set(options.selectedIndexes);
    return operations
      .map((operation, index) => ({ operation, index }))
      .filter(({ index }) => wanted.has(index));
  }
  return operations.map((operation, index) => ({ operation, index }));
}

function envelope(
  task: Record<string, unknown> | null,
  completion: Record<string, unknown> | null,
): ActivityEnvelope {
  return {
    task: task ? (task as Record<string, unknown>) : null,
    completion,
  };
}

export function applyProposal(
  store: TaskStore,
  proposalId: string,
  options: ApplyProposalOptions,
): ApplyProposalResult {
  return store.transaction(() => {
    const existing = store.getProposal(proposalId);
    if (!existing) {
      throw new AgentError("not_found", "Proposal was not found.", 404);
    }
    if (existing.status !== "pending") {
      throw new AgentError(
        "proposal_not_pending",
        `Proposal is ${existing.status}; it cannot be applied.`,
        409,
      );
    }
    if (existing.expiresAt && Date.parse(existing.expiresAt) <= Date.now()) {
      store.markProposal(existing.id, "expired");
      throw new AgentError("proposal_expired", "Proposal expired. Ask again for a fresh one.", 409);
    }
    if (existing.baseRev !== null && options.baseRev === undefined) {
      throw new AgentError(
        "proposal_conflict",
        "This proposal needs its base revision. Refresh and review it again.",
        412,
      );
    }
    if (options.baseRev !== undefined && existing.baseRev !== options.baseRev) {
      throw new AgentError(
        "proposal_conflict",
        `Proposal base rev ${existing.baseRev ?? "none"} does not match ${options.baseRev}.`,
        412,
      );
    }
    const operations = parseOperations(
      String(store.getProposalRow(proposalId)?.["operations_json"] ?? "[]"),
    );
    const selected = selectOperations(operations, options);
    if (selected.length === 0) {
      throw new AgentError("invalid_proposal", "Select at least one operation.", 400);
    }
    const selectedHash = hashPayload(
      selected.map(({ operation }) => operation),
    );
    const allSelected = selected.length === operations.length;
    if (allSelected && selectedHash !== existing.payloadHash) {
      throw new AgentError(
        "proposal_conflict",
        "The proposal payload changed since it was previewed. Refresh and review it again.",
        412,
      );
    }
    if (options.payloadHash && selectedHash !== options.payloadHash) {
      throw new AgentError(
        "proposal_conflict",
        "The proposal payload changed since it was previewed. Refresh and review it again.",
        412,
      );
    }

    const batchId = newId();
    const activityIds: number[] = [];
    let applied = 0;

    for (const { operation } of selected) {
      const opId = operation.operationId;
      const title = "title" in operation ? operation.title : undefined;
      if (operation.kind === "create_task") {
        const before = null;
        const created = store.createTask({
          ...operation.input,
          id: operation.input.id ?? newId(),
        });
        const row = store.getTaskRow(created.id);
        const seq = store.insertActivity({
          actor: "user",
          actorId: options.actorId,
          batchId,
          opId,
          action: "task.create",
          entityType: "task",
          entityId: created.id,
          before,
          after: envelope(row, null),
          summary: `Created “${created.title}” via approved proposal`,
        });
        activityIds.push(seq);
        applied += 1;
        continue;
      }

      const taskId = operation.taskId;
      if (operation.kind === "update_task") {
        const beforeRow = store.getTaskRow(taskId);
        store.updateTask(taskId, operation.patch, operation.baseRev);
        const afterRow = store.getTaskRow(taskId);
        const seq = store.insertActivity({
          actor: "user",
          actorId: options.actorId,
          batchId,
          opId,
          action: "task.update",
          entityType: "task",
          entityId: taskId,
          before: envelope(beforeRow, null),
          after: envelope(afterRow, null),
          summary: `Updated ${title ? `“${title}”` : "task"} via approved proposal`,
        });
        activityIds.push(seq);
        applied += 1;
        continue;
      }

      if (operation.kind === "delete_task") {
        const beforeRow = store.getTaskRow(taskId);
        const result = store.softDeleteTask(taskId, operation.baseRev);
        const afterRow = store.getTaskRow(taskId);
        const seq = store.insertActivity({
          actor: "user",
          actorId: options.actorId,
          batchId,
          opId,
          action: "task.delete",
          entityType: "task",
          entityId: taskId,
          before: envelope(beforeRow, null),
          after: envelope(afterRow, null),
          summary: `Deleted ${title ? `“${title}”` : "task"} via approved proposal`,
        });
        activityIds.push(seq);
        applied += 1;
        void result;
        continue;
      }

      if (operation.kind === "complete_task") {
        const beforeRow = store.getTaskRow(taskId);
        const result = store.completeTask(taskId, operation.occurrenceKey, operation.baseRev);
        const afterRow = store.getTaskRow(taskId);
        const seq = store.insertActivity({
          actor: "user",
          actorId: options.actorId,
          batchId,
          opId,
          action: "task.complete",
          entityType: "task",
          entityId: taskId,
          before: envelope(beforeRow, null),
          after: envelope(afterRow, result.completion),
          summary: `Completed ${title ? `“${title}”` : "task"} via approved proposal`,
        });
        activityIds.push(seq);
        applied += 1;
        continue;
      }

      if (operation.kind === "snooze_task") {
        const beforeRow = store.getTaskRow(taskId);
        store.snoozeTask(taskId, operation.until, operation.baseRev);
        const afterRow = store.getTaskRow(taskId);
        const seq = store.insertActivity({
          actor: "user",
          actorId: options.actorId,
          batchId,
          opId,
          action: "task.snooze",
          entityType: "task",
          entityId: taskId,
          before: envelope(beforeRow, null),
          after: envelope(afterRow, null),
          summary: `Snoozed ${title ? `“${title}”` : "task"} via approved proposal`,
        });
        activityIds.push(seq);
        applied += 1;
        continue;
      }

      if (operation.kind === "skip_task") {
        const beforeRow = store.getTaskRow(taskId);
        const result = store.skipTask(taskId, operation.occurrenceKey, operation.baseRev);
        const afterRow = store.getTaskRow(taskId);
        const seq = store.insertActivity({
          actor: "user",
          actorId: options.actorId,
          batchId,
          opId,
          action: "task.skip",
          entityType: "task",
          entityId: taskId,
          before: envelope(beforeRow, null),
          after: envelope(afterRow, result.completion),
          summary: `Skipped ${title ? `“${title}”` : "task"} via approved proposal`,
        });
        activityIds.push(seq);
        applied += 1;
        continue;
      }
    }

    const appliedRev = store.currentMaxRev();
    const lastActivity = activityIds[activityIds.length - 1] ?? null;
    store.markProposal(proposalId, "applied", appliedRev, lastActivity);
    const updated = store.getProposal(proposalId);
    if (!updated) {
      throw new AgentError("write_failed", "Proposal disappeared after apply.", 500);
    }
    return {
      proposal: attachPreview(updated),
      applied,
      batchId,
      activityIds,
      appliedRev,
    };
  });
}

export function dismissProposal(
  store: TaskStore,
  proposalId: string,
  actorId: string,
): ProposalRecord {
  return store.transaction(() => {
    const proposal = store.getProposal(proposalId);
    if (!proposal) throw new AgentError("not_found", "Proposal was not found.", 404);
    if (proposal.status !== "pending") {
      throw new AgentError(
        "proposal_not_pending",
        `Proposal is ${proposal.status}; it cannot be dismissed.`,
        409,
      );
    }
    const batchId = newId();
    store.insertActivity({
      actor: "user",
      actorId,
      batchId,
      action: "proposal.dismiss",
      entityType: "proposal",
      entityId: proposalId,
      before: { status: proposal.status },
      after: { status: "dismissed" },
      summary: `Dismissed proposal “${proposal.summary}”`,
    });
    store.markProposal(proposalId, "dismissed");
    const updated = store.getProposal(proposalId);
    if (!updated) throw new AgentError("write_failed", "Proposal was not persisted.", 500);
    return attachPreview(updated);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENVELOPE_KEYS = new Set(["task", "completion"]);

/**
 * Activity snapshots are untrusted input (they can arrive through sync or a
 * restored backup). Only the two documented envelope keys are accepted, and
 * each must be an object or null; anything else fails closed with a typed
 * error instead of being replayed as a partial row.
 */
function parseEnvelope(json: unknown): ActivityEnvelope {
  if (json === null || json === undefined || json === "") {
    return { task: null, completion: null };
  }
  if (typeof json !== "string") {
    throw new AgentError(
      "invalid_snapshot",
      "Activity snapshot is not stored as JSON text.",
      400,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AgentError(
      "invalid_snapshot",
      "Activity snapshot is not valid JSON.",
      400,
    );
  }
  if (parsed === null) return { task: null, completion: null };
  if (!isRecord(parsed)) {
    throw new AgentError(
      "invalid_snapshot",
      "Activity snapshot must be an object envelope.",
      400,
    );
  }
  for (const key of Object.keys(parsed)) {
    if (!ENVELOPE_KEYS.has(key)) {
      throw new AgentError(
        "invalid_snapshot",
        `Activity snapshot contains an unexpected key: ${key.slice(0, 64)}.`,
        400,
      );
    }
  }
  const task = parsed["task"];
  const completion = parsed["completion"];
  if (task !== undefined && task !== null && !isRecord(task)) {
    throw new AgentError(
      "invalid_snapshot",
      "Activity snapshot task must be an object or null.",
      400,
    );
  }
  if (
    completion !== undefined &&
    completion !== null &&
    !isRecord(completion)
  ) {
    throw new AgentError(
      "invalid_snapshot",
      "Activity snapshot completion must be an object or null.",
      400,
    );
  }
  return {
    task: (task as Record<string, unknown> | null | undefined) ?? null,
    completion:
      (completion as Record<string, unknown> | null | undefined) ?? null,
  };
}

export function undoProposal(
  store: TaskStore,
  proposalId: string,
  actorId: string,
): { proposal: ProposalRecord; undone: number; batchId: string } {
  return store.transaction(() => {
    const proposal = store.getProposal(proposalId);
    if (!proposal) throw new AgentError("not_found", "Proposal was not found.", 404);
    if (proposal.status !== "applied") {
      throw new AgentError(
        "proposal_not_applied",
        `Proposal is ${proposal.status}; there is nothing to undo.`,
        409,
      );
    }
    const anchor =
      proposal.appliedActivityId != null
        ? store.activitySeq(proposal.appliedActivityId)
        : null;
    const originalBatchId = anchor ? String(anchor["batch_id"] ?? "") : "";
    if (!originalBatchId) {
      throw new AgentError(
        "undo_unavailable",
        "The applied batch is no longer in the activity log.",
        409,
      );
    }
    const rows = store
      .activityForBatch(originalBatchId)
      .filter((row) => !String(row["action"] ?? "").startsWith("undo."))
      .reverse();
    if (rows.length === 0) {
      throw new AgentError("undo_unavailable", "No applied activity was found.", 409);
    }
    const undoBatchId = newId();
    let undone = 0;
    for (const row of rows) {
      const before = parseEnvelope(row["before_json"]);
      const after = parseEnvelope(row["after_json"]);
      const action = String(row["action"] ?? "");
      const entityId = String(row["entity_id"] ?? "");
      if (action === "task.create") {
        if (after.task && after.task["id"]) {
          const createdId = String(after.task["id"]);
          const live = store.getTaskRow(createdId);
          if (live && live["deleted_at"] == null) {
            store.softDeleteTask(createdId);
            store.insertActivity({
              actor: "user",
              actorId,
              batchId: undoBatchId,
              action: "undo.task.create",
              entityType: "task",
              entityId: createdId,
              before: envelope(live, null),
              after: envelope(store.getTaskRow(createdId), null),
              summary: "Undid an approved creation",
            });
            undone += 1;
          }
        }
        continue;
      }
      const currentRow = store.getTaskRow(entityId);
      if (before.task) {
        if (after.task && currentRow) {
          const expectedRev = Number(after.task["rev"]);
          if (
            Number.isFinite(expectedRev) &&
            Number(currentRow["rev"]) !== expectedRev
          ) {
            throw new AgentError(
              "undo_conflict",
              "That item changed after the proposal was applied; nothing was undone.",
              409,
            );
          }
        }
        store.restoreTaskRow(before.task, entityId);
      }
      if (after.completion && after.completion["id"]) {
        store.softDeleteCompletion(
          String(after.completion["id"]),
          entityId,
        );
      }
      store.insertActivity({
        actor: "user",
        actorId,
        batchId: undoBatchId,
        action: `undo.${action || "task.update"}`,
        entityType: "task",
        entityId,
        before: envelope(currentRow, null),
        after: envelope(before.task, null),
        summary: `Undid ${action.replace("task.", "")} from approved proposal`,
      });
      undone += 1;
    }
    store.markProposal(proposalId, "dismissed");
    const updated = store.getProposal(proposalId);
    if (!updated) throw new AgentError("write_failed", "Proposal was not persisted.", 500);
    return { proposal: attachPreview(updated), undone, batchId: undoBatchId };
  });
}

/**
 * Undo one immediate write batch produced by an MCP tool. Proposal apply uses
 * the proposal-specific wrapper above; both end up replaying the same activity
 * snapshots.
 */
export function undoActivityBatch(
  store: TaskStore,
  batchId: string,
  actorId: string,
): { undone: number; batchId: string } {
  return store.transaction(() => {
    const rows = store
      .activityForBatch(batchId)
      .filter((row) => !String(row["action"] ?? "").startsWith("undo."))
      .reverse();
    if (rows.length === 0) {
      throw new AgentError("undo_unavailable", "Nothing to undo for this batch.", 404);
    }
    const undoBatchId = newId();
    let undone = 0;
    for (const row of rows) {
      const before = parseEnvelope(row["before_json"]);
      const after = parseEnvelope(row["after_json"]);
      const action = String(row["action"] ?? "");
      const entityId = String(row["entity_id"] ?? "");
      if (action === "task.create") {
        if (after.task && after.task["id"]) {
          const createdId = String(after.task["id"]);
          const live = store.getTaskRow(createdId);
          if (live && live["deleted_at"] == null) {
            store.softDeleteTask(createdId);
            store.insertActivity({
              actor: "user",
              actorId,
              batchId: undoBatchId,
              action: "undo.task.create",
              entityType: "task",
              entityId: createdId,
              before: envelope(live, null),
              after: envelope(store.getTaskRow(createdId), null),
              summary: "Undid an assistant creation",
            });
            undone += 1;
          }
        }
        continue;
      }
      if (before.task) {
        const current = store.getTaskRow(entityId);
        if (current && after.task) {
          const expectedRev = Number(after.task["rev"]);
          if (
            Number.isFinite(expectedRev) &&
            Number(current["rev"]) !== expectedRev
          ) {
            throw new AgentError(
              "undo_conflict",
              "That item changed after the assistant write; nothing was undone.",
              409,
            );
          }
        }
        store.restoreTaskRow(before.task, entityId);
        if (after.completion && after.completion["id"]) {
          store.softDeleteCompletion(
            String(after.completion["id"]),
            entityId,
          );
        }
        store.insertActivity({
          actor: "user",
          actorId,
          batchId: undoBatchId,
          action: `undo.${action || "task.update"}`,
          entityType: "task",
          entityId,
          before: envelope(current, null),
          after: envelope(before.task, null),
          summary: `Undid ${action.replace("task.", "")} from an assistant change`,
        });
        undone += 1;
      }
    }
    return { undone, batchId: undoBatchId };
  });
}
