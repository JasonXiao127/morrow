/**
 * Policy gate (plan §6):
 *
 * Immediate, with undo:
 *   - one create, update (ordinary fields), complete, snooze, or skip
 *
 * Proposal + UI approval:
 *   - any batch, delete, recurrence change, list move, or >1 item
 *
 * There is no delete tool. A deletion can only exist as a proposal operation
 * and is only executed by POST /api/proposals/:id/apply.
 */
import {
  AgentError,
  type ProposalOperation,
  type ProposalOperationKind,
  type ProposalPreview,
  type TaskUpdateInput,
} from "./types.js";
import { isStructuralTaskUpdate } from "./util.js";

export const MAX_PROPOSAL_OPERATIONS = 20;

export const PROPOSAL_KINDS: readonly ProposalOperationKind[] = [
  "create_task",
  "update_task",
  "complete_task",
  "snooze_task",
  "skip_task",
  "delete_task",
];

export interface PolicyDecision {
  immediate: boolean;
  requiresProposal: boolean;
  reason?: string;
}

export function decidePolicy(
  kind: ProposalOperationKind,
  payload: {
    patch?: TaskUpdateInput;
    batchSize?: number;
  } = {},
): PolicyDecision {
  const batchSize = payload.batchSize ?? 1;
  if (batchSize > 1) {
    return {
      immediate: false,
      requiresProposal: true,
      reason: "More than one item changes at once.",
    };
  }
  if (kind === "delete_task") {
    return {
      immediate: false,
      requiresProposal: true,
      reason: "Deletes always require approval.",
    };
  }
  if (kind === "update_task") {
    const patch = payload.patch ?? {};
    if (patch.status === "cancelled") {
      return {
        immediate: false,
        requiresProposal: true,
        reason: "Cancelling a task is a delete-like change.",
      };
    }
    if (isStructuralTaskUpdate(patch as Record<string, unknown>)) {
      return {
        immediate: false,
        requiresProposal: true,
        reason: "Recurrence changes and list moves require approval.",
      };
    }
  }
  return { immediate: true, requiresProposal: false };
}

/** Throws with `proposal_required` when an immediate tool would overreach. */
export function assertImmediateAllowed(
  kind: ProposalOperationKind,
  payload: { patch?: TaskUpdateInput; batchSize?: number } = {},
): void {
  const decision = decidePolicy(kind, payload);
  if (!decision.immediate) {
    throw new AgentError(
      "proposal_required",
      `${decision.reason ?? "This change is too broad."} Use reminders_propose; nothing has been changed.`,
      409,
    );
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateOperations(
  operations: unknown,
): asserts operations is ProposalOperation[] {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new AgentError("invalid_proposal", "A proposal needs at least one operation.");
  }
  if (operations.length > MAX_PROPOSAL_OPERATIONS) {
    throw new AgentError(
      "invalid_proposal",
      `A proposal may contain at most ${MAX_PROPOSAL_OPERATIONS} operations.`,
    );
  }
  const ids = new Set<string>();
  for (const [index, raw] of operations.entries()) {
    if (!raw || typeof raw !== "object") {
      throw new AgentError("invalid_proposal", `Operation ${index + 1} is not an object.`);
    }
    const op = raw as Record<string, unknown>;
    const kind = op["kind"];
    if (!PROPOSAL_KINDS.includes(kind as ProposalOperationKind)) {
      throw new AgentError(
        "invalid_proposal",
        `Operation ${index + 1} has an unsupported kind.`,
      );
    }
    const operationId = op["operationId"];
    const resolvedId = nonEmptyString(operationId)
      ? operationId
      : `op-${index + 1}`;
    if (ids.has(resolvedId)) {
      throw new AgentError("invalid_proposal", `Duplicate operation id ${resolvedId}.`);
    }
    ids.add(resolvedId);
    if (kind === "create_task") {
      const input = op["input"];
      if (!input || typeof input !== "object") {
        throw new AgentError("invalid_proposal", `Operation ${resolvedId} has no input.`);
      }
      if (!nonEmptyString((input as Record<string, unknown>)["title"])) {
        throw new AgentError("invalid_proposal", `Operation ${resolvedId} needs a title.`);
      }
      continue;
    }
    if (!nonEmptyString(op["taskId"])) {
      throw new AgentError("invalid_proposal", `Operation ${resolvedId} needs a taskId.`);
    }
    if (kind === "update_task") {
      const patch = op["patch"];
      if (!patch || typeof patch !== "object" || Object.keys(patch).length === 0) {
        throw new AgentError("invalid_proposal", `Operation ${resolvedId} has an empty patch.`);
      }
    }
    if (kind === "snooze_task" && !nonEmptyString(op["until"])) {
      throw new AgentError("invalid_proposal", `Operation ${resolvedId} needs an until timestamp.`);
    }
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (nonEmptyString(value)) return value;
  }
  return null;
}

/** Human-readable preview used by proposal cards. */
function clip(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function previewDue(input: {
  dueAt?: string | null;
  dueDate?: string | null;
  allDay?: boolean;
}): string | null {
  if (input.allDay && input.dueDate) return `all-day ${input.dueDate}`;
  if (input.dueDate) return `due ${input.dueDate}`;
  if (input.dueAt) return `due ${input.dueAt}`;
  return null;
}

function previewRecurrence(input: {
  rrule?: string | null;
  dtstartLocal?: string | null;
  recurrenceUntilUtc?: string | null;
  recurrenceUntilDate?: string | null;
  recurrenceCount?: number | null;
  wkst?: string | null;
  recurrenceMode?: "schedule" | "completion";
  clampPolicy?: "skip" | "last-day";
}): string | null {
  if (!input.rrule) return null;
  const parts = [`repeats ${input.rrule}`];
  if (input.dtstartLocal) parts.push(`from ${input.dtstartLocal}`);
  if (input.recurrenceUntilDate) parts.push(`until ${input.recurrenceUntilDate}`);
  else if (input.recurrenceUntilUtc) parts.push(`until ${input.recurrenceUntilUtc}`);
  else if (input.recurrenceCount) {
    parts.push(`for ${input.recurrenceCount} occurrence${input.recurrenceCount === 1 ? "" : "s"}`);
  }
  if (input.recurrenceMode) parts.push(`${input.recurrenceMode} mode`);
  if (input.wkst) parts.push(`week starts ${input.wkst}`);
  if (input.clampPolicy) parts.push(`clamp ${input.clampPolicy}`);
  return parts.join(", ");
}

function previewReminder(input: {
  remindAt?: string | null;
  reminderTimeLocal?: string | null;
  remindOffsetMinutes?: number | null;
}): string | null {
  if (typeof input.remindOffsetMinutes === "number") {
    return `remind ${input.remindOffsetMinutes} min ${input.remindOffsetMinutes < 0 ? "before" : "after"}`;
  }
  if (input.reminderTimeLocal) return `remind at ${input.reminderTimeLocal}`;
  if (input.remindAt) return `remind ${input.remindAt}`;
  return null;
}

function previewTaskBits(input: {
  dueAt?: string | null;
  dueDate?: string | null;
  allDay?: boolean;
  priority?: number;
  notes?: string | null;
  rrule?: string | null;
  dtstartLocal?: string | null;
  recurrenceUntilUtc?: string | null;
  recurrenceUntilDate?: string | null;
  recurrenceCount?: number | null;
  wkst?: string | null;
  recurrenceMode?: "schedule" | "completion";
  clampPolicy?: "skip" | "last-day";
  remindAt?: string | null;
  reminderTimeLocal?: string | null;
  remindOffsetMinutes?: number | null;
}): string[] {
  const bits: string[] = [];
  const due = previewDue(input);
  if (due) bits.push(due);
  if (input.allDay && !input.dueDate) bits.push("all-day");
  if (input.priority) bits.push(`priority ${input.priority}`);
  const recurrence = previewRecurrence(input);
  if (recurrence) bits.push(recurrence);
  const reminder = previewReminder(input);
  if (reminder) bits.push(reminder);
  if (input.notes?.trim()) bits.push(`notes: ${clip(input.notes.trim())}`);
  return bits;
}

export function previewOperation(op: ProposalOperation): ProposalPreview {
  if (op.kind === "create_task") {
    const bits = [`Create “${op.input.title}”`, ...previewTaskBits(op.input)];
    return {
      operationId: op.operationId,
      kind: op.kind,
      taskId: op.input.id ?? null,
      title: op.input.title,
      detail: bits.join(" · "),
      before: null,
      after: { ...op.input },
    };
  }
  if (op.kind === "update_task") {
    const patch = op.patch;
    const changed = Object.keys(patch).filter((key) => patch[key as keyof TaskUpdateInput] !== undefined);
    const title = firstString(op.title, patch.title);
    const recurrenceKeys = [
      "rrule",
      "dtstartLocal",
      "recurrenceUntilUtc",
      "recurrenceUntilDate",
      "recurrenceCount",
      "wkst",
      "recurrenceMode",
      "clampPolicy",
    ];
    const recurrenceChanged = changed.some((key) => recurrenceKeys.includes(key));
    const bits: string[] = [];
    const dueChanged =
      changed.includes("dueAt") ||
      changed.includes("dueDate") ||
      changed.includes("allDay");
    if (dueChanged) {
      bits.push(`Reschedule ${title ? `“${title}”` : "task"}`);
      const due = previewDue({
        dueAt: patch.dueAt,
        dueDate: patch.dueDate,
        allDay: patch.allDay,
      });
      if (due) bits.push(due);
    }
    if (recurrenceChanged) {
      bits.push(`Change recurrence for ${title ? `“${title}”` : "task"}`);
      const recurrence = previewRecurrence(patch);
      if (recurrence) bits.push(recurrence);
    }
    if (changed.includes("listId") && !dueChanged && !recurrenceChanged) {
      bits.push(`Move ${title ? `“${title}”` : "task"} to another list`);
    }
    const fieldBits: string[] = [];
    if (typeof patch.priority === "number") fieldBits.push(`priority ${patch.priority}`);
    if (patch.notes !== undefined) {
      fieldBits.push(
        `notes: ${patch.notes?.trim() ? clip(patch.notes.trim()) : "cleared"}`,
      );
    }
    const rest = changed.filter(
      (key) =>
        ![
          "priority",
          "notes",
          "title",
          "dueAt",
          "dueDate",
          "allDay",
          "listId",
          ...recurrenceKeys,
        ].includes(key),
    );
    if (rest.length > 0) fieldBits.push(rest.join(", "));
    if (fieldBits.length > 0) {
      if (bits.length === 0) bits.push(`Update ${title ? `“${title}”` : "task"}`);
      bits.push(...fieldBits);
    }
    if (bits.length === 0) bits.push(`Update ${title ? `“${title}”` : "task"}`);
    return {
      operationId: op.operationId,
      kind: op.kind,
      taskId: op.taskId,
      title,
      detail: bits.join(" · "),
      before: null,
      after: { ...patch },
    };
  }
  if (op.kind === "delete_task") {
    return {
      operationId: op.operationId,
      kind: op.kind,
      taskId: op.taskId,
      title: op.title ?? null,
      detail: `Delete ${op.title ? `“${op.title}”` : "task"}`,
      before: null,
      after: null,
    };
  }
  if (op.kind === "snooze_task") {
    return {
      operationId: op.operationId,
      kind: op.kind,
      taskId: op.taskId,
      title: op.title ?? null,
      detail: `Snooze ${op.title ? `“${op.title}”` : "task"} until ${op.until}`,
      before: null,
      after: { snoozedUntil: op.until },
    };
  }
  if (op.kind === "complete_task") {
    return {
      operationId: op.operationId,
      kind: op.kind,
      taskId: op.taskId,
      title: op.title ?? null,
      detail: `Complete ${op.title ? `“${op.title}”` : "task"}`,
      before: null,
      after: { status: "done" },
    };
  }
  return {
    operationId: op.operationId,
    kind: op.kind,
    taskId: op.taskId,
    title: op.title ?? null,
    detail: `Skip ${op.title ? `“${op.title}”` : "this occurrence"}`,
    before: null,
    after: { skipped: true },
  };
}

export function previewOperations(operations: ProposalOperation[]): ProposalPreview[] {
  return operations.map(previewOperation);
}
