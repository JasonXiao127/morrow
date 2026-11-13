import {
  apiErrorMessage,
  apiFetch,
  ifMatchHeaders,
  isApiError,
  isConflict,
  taskApi,
  type CreateTaskInput,
  type Task,
} from "@/api";
import { getDb, type OutboxRecord } from "./idb";
import { uuidv7 } from "./utils";

/**
 * Offline outbox (plan §7).
 *
 * Create/update/complete/snooze/skip/delete are queued FIFO in IndexedDB and
 * replayed on launch, `online`, and `visibilitychange`. Replay is serialized
 * across tabs with Web Locks and MUST run before bootstrap so a fresh snapshot
 * cannot overwrite an unacked local change. Conflicts (409/412/428) stop the
 * queue and surface in the outbox panel; nothing is silently discarded or
 * last-write-wins.
 */

export const OUTBOX_REPLAY_ENABLED = true;
const LAST_SYNCED_KEY = "morrow.outbox.lastSyncedAt";

let replaying = false;

export function outboxIsReplaying(): boolean {
  return replaying;
}

function setReplaying(value: boolean): void {
  replaying = value;
  notifyOutboxChanged();
}

export type OutboxKind = OutboxRecord["kind"];

export interface EnqueueInput {
  kind: OutboxKind;
  entityId: string;
  payload: Record<string, unknown>;
}

export type ReplayStop =
  | "disabled"
  | "offline"
  | "conflict"
  | "error"
  | "empty";

export interface ReplayResult {
  replayed: number;
  remaining: number;
  conflicts: number;
  stoppedBy?: ReplayStop;
}

function notifyOutboxChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("morrow:outbox"));
  }
}

function recordSyncedNow(): void {
  try {
    localStorage.setItem(LAST_SYNCED_KEY, new Date().toISOString());
  } catch {
    // Storage may be unavailable; the in-memory event still refreshes the UI.
  }
  notifyOutboxChanged();
}

export function lastSyncedAt(): string | null {
  try {
    return localStorage.getItem(LAST_SYNCED_KEY);
  } catch {
    return null;
  }
}

export async function enqueueOutbox(input: EnqueueInput): Promise<OutboxRecord> {
  const record: OutboxRecord = {
    opId: uuidv7(),
    kind: input.kind,
    entityId: input.entityId,
    payload: input.payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  const db = await getDb();
  await db.add("outbox", record);
  notifyOutboxChanged();
  return record;
}

export async function listOutbox(): Promise<OutboxRecord[]> {
  try {
    const db = await getDb();
    return db.getAllFromIndex("outbox", "by-created");
  } catch {
    return [];
  }
}

export async function getOutboxCount(): Promise<number> {
  try {
    const db = await getDb();
    return await db.count("outbox");
  } catch {
    return 0;
  }
}

export async function getOutboxConflicts(): Promise<number> {
  const records = await listOutbox();
  return records.filter((record) => record.conflict).length;
}

export async function deleteOutbox(opId: string): Promise<void> {
  const db = await getDb();
  await db.delete("outbox", opId);
  notifyOutboxChanged();
}

export async function discardOutbox(opId: string): Promise<void> {
  await deleteOutbox(opId);
}

export async function markOutboxAttempt(
  opId: string,
  lastError: string,
  conflict = false,
): Promise<void> {
  const db = await getDb();
  const existing = await db.get("outbox", opId);
  if (!existing) return;
  await db.put("outbox", {
    ...existing,
    attempts: existing.attempts + 1,
    lastError,
    conflict: conflict || existing.conflict,
  });
  notifyOutboxChanged();
}

export async function clearOutboxConflict(opId: string): Promise<void> {
  const db = await getDb();
  const existing = await db.get("outbox", opId);
  if (!existing) return;
  await db.put("outbox", {
    ...existing,
    conflict: false,
    lastError: undefined,
  });
  notifyOutboxChanged();
}

function numericRev(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function occurrenceKeyFrom(task: Task): string | undefined {
  return task.nextOccurrenceAt || task.dueAt || task.dueDate || undefined;
}

/**
 * A queued op normally carries the revision it was queued against. A chained
 * op on an offline-created task does not: the server has not assigned one yet.
 * Resolve it from the server after the create has replayed.
 */
async function revisionFor(record: OutboxRecord): Promise<number | undefined> {
  const stored = numericRev(record.payload["rev"]);
  if (stored !== undefined) return stored;
  const task = await taskApi.get(record.entityId);
  return task.rev;
}

/** Read the revision from a mutation response, falling back to a fresh GET. */
async function responseRev(
  response: { rev?: unknown } | undefined,
  taskId: string,
): Promise<number | undefined> {
  const rev = numericRev(response?.rev);
  if (rev !== undefined) return rev;
  try {
    return (await taskApi.get(taskId)).rev;
  } catch {
    return undefined;
  }
}

async function replayOne(record: OutboxRecord): Promise<number | undefined> {
  const headers = { "Idempotency-Key": record.opId };
  switch (record.kind) {
    case "create": {
      const { taskTitle: _taskTitle, ...rest } = record.payload;
      const payload = {
        ...(rest as unknown as CreateTaskInput),
        id: (record.payload["id"] as string | undefined) ?? record.entityId,
      };
      const created = await taskApi.create(payload);
      return created.rev;
    }
    case "update": {
      const updated = await apiFetch<{ rev?: unknown }>(
        `/tasks/${encodeURIComponent(record.entityId)}`,
        {
          method: "PATCH",
          body: (record.payload["patch"] as Record<string, unknown>) ?? {},
          headers: {
            ...headers,
            ...ifMatchHeaders(await revisionFor(record)),
          },
        },
      );
      return responseRev(updated, record.entityId);
    }
    case "complete": {
      const completed = await apiFetch<{ rev?: unknown }>(
        `/tasks/${encodeURIComponent(record.entityId)}/complete`,
        {
          method: "POST",
          body: {
            occurrenceKey: record.payload["occurrenceKey"] ?? undefined,
          },
          headers: {
            ...headers,
            ...ifMatchHeaders(await revisionFor(record)),
          },
        },
      );
      return responseRev(completed, record.entityId);
    }
    case "snooze": {
      const snoozed = await apiFetch<{ rev?: unknown }>(
        `/tasks/${encodeURIComponent(record.entityId)}/snooze`,
        {
          method: "POST",
          body: { until: record.payload["until"] },
          headers: {
            ...headers,
            ...ifMatchHeaders(await revisionFor(record)),
          },
        },
      );
      return responseRev(snoozed, record.entityId);
    }
    case "skip": {
      const skipped = await apiFetch<{ rev?: unknown }>(
        `/tasks/${encodeURIComponent(record.entityId)}/skip`,
        {
          method: "POST",
          body: {
            occurrenceKey: record.payload["occurrenceKey"] ?? undefined,
          },
          headers: {
            ...headers,
            ...ifMatchHeaders(await revisionFor(record)),
          },
        },
      );
      return responseRev(skipped, record.entityId);
    }
    case "delete": {
      await apiFetch(`/tasks/${encodeURIComponent(record.entityId)}`, {
        method: "DELETE",
        headers: {
          ...headers,
          ...ifMatchHeaders(await revisionFor(record)),
        },
      });
      return undefined;
    }
  }
}

/**
 * A successful op advances the task revision. Later queued ops on the same
 * task must use that revision or they conflict with our own earlier write.
 * Persist the update so a reload before the next replay stays correct.
 */
async function propagateRevision(
  entityId: string,
  rev: number,
  operations: OutboxRecord[],
  fromIndex: number,
): Promise<void> {
  const db = await getDb();
  for (let index = fromIndex + 1; index < operations.length; index += 1) {
    const next = operations[index];
    if (!next || next.entityId !== entityId) continue;
    const stored = numericRev(next.payload["rev"]);
    if (stored === undefined || stored >= rev) continue;
    next.payload = { ...next.payload, rev };
    await db.put("outbox", next);
  }
}

async function runReplay(): Promise<ReplayResult> {
  const empty = await getOutboxCount();
  if (!OUTBOX_REPLAY_ENABLED) {
    return { replayed: 0, remaining: empty, conflicts: 0, stoppedBy: "disabled" };
  }
  if (empty === 0) {
    return { replayed: 0, remaining: 0, conflicts: 0, stoppedBy: "empty" };
  }

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return {
      replayed: 0,
      remaining: empty,
      conflicts: await getOutboxConflicts(),
      stoppedBy: "offline",
    };
  }

  const operations = await listOutbox();
  let replayed = 0;

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (!operation) continue;
    try {
      const rev = await replayOne(operation);
      await deleteOutbox(operation.opId);
      replayed += 1;
      if (rev !== undefined) {
        await propagateRevision(operation.entityId, rev, operations, index);
      }
    } catch (error) {
      const conflict = isConflict(error) || (isApiError(error) && error.status === 428);
      await markOutboxAttempt(operation.opId, apiErrorMessage(error), conflict);
      if (replayed > 0) recordSyncedNow();
      return {
        replayed,
        remaining: await getOutboxCount(),
        conflicts: await getOutboxConflicts(),
        stoppedBy: conflict
          ? "conflict"
          : isApiError(error) && error.status < 500
            ? "error"
            : "offline",
      };
    }
  }

  if (replayed > 0) recordSyncedNow();
  return {
    replayed,
    remaining: await getOutboxCount(),
    conflicts: await getOutboxConflicts(),
  };
}

/**
 * Serialize replay across tabs with Web Locks. Falls back to a single-tab run
 * where the API is unavailable (older Safari).
 */
let inFlightReplay: Promise<ReplayResult> | null = null;

export function replayOutbox(): Promise<ReplayResult> {
  // Same-tab coalescing: online + visibilitychange (and the launch guard) can
  // fire together. Web Locks serializes across tabs, but on plain HTTP (where
  // the Lock Manager may be unavailable) two calls would race the queue.
  if (inFlightReplay) return inFlightReplay;

  const run = async (): Promise<ReplayResult> => {
    setReplaying(true);
    try {
      if (typeof navigator !== "undefined" && "locks" in navigator) {
        return await navigator.locks.request("morrow-outbox", () => runReplay());
      }
      return await runReplay();
    } finally {
      setReplaying(false);
    }
  };

  inFlightReplay = run().finally(() => {
    inFlightReplay = null;
  });
  return inFlightReplay;
}

/**
 * Explicit "keep mine" retry for a conflicted queued operation: pull the
 * current revision, re-base the queued operation on it, clear the conflict,
 * then replay FIFO. The user made this choice in the outbox panel.
 */
export async function retryOutboxRecord(opId: string): Promise<ReplayResult> {
  const records = await listOutbox();
  const record = records.find((candidate) => candidate.opId === opId);
  if (!record) return { replayed: 0, remaining: 0, conflicts: 0, stoppedBy: "empty" };

  if (record.kind !== "create") {
    try {
      const task = await taskApi.get(record.entityId);
      const db = await getDb();
      await db.put("outbox", {
        ...record,
        payload: {
          ...record.payload,
          rev: task.rev,
          ...(record.kind === "complete" || record.kind === "skip"
            ? { occurrenceKey: occurrenceKeyFrom(task) }
            : {}),
        },
        conflict: false,
        lastError: undefined,
      });
      notifyOutboxChanged();
    } catch (error) {
      // A queued delete for a task that no longer exists has nothing to
      // replay. Every other kind must surface the missing task instead of
      // silently discarding the user's change.
      if (isApiError(error) && error.status === 404) {
        if (record.kind === "delete") {
          await deleteOutbox(opId);
          return replayOutbox();
        }
        await markOutboxAttempt(
          opId,
          "Task no longer exists. Discard this change or reload.",
          true,
        );
        return {
          replayed: 0,
          remaining: await getOutboxCount(),
          conflicts: await getOutboxConflicts(),
          stoppedBy: "conflict",
        };
      }
      throw error;
    }
  } else {
    await clearOutboxConflict(opId);
  }

  return replayOutbox();
}

let launchReplay: Promise<ReplayResult> | null = null;

// ---------------------------------------------------------------------------
// M2-OUTBOX-BEGIN: online / visibility / launch replay triggers
// ---------------------------------------------------------------------------

let triggersInstalled = false;

/**
 * Install the capture/online/visibility triggers exactly once. Idempotent so
 * repeated component mounts and StrictMode do not stack listeners.
 * `visibilitychange` fires after a phone unlocks; `online` after a tunnel or
 * airplane mode; launch is handled by `replayOutboxBeforeBootstrap`.
 */
export function installOutboxTriggers(): void {
  if (triggersInstalled || typeof window === "undefined") return;
  triggersInstalled = true;

  const kick = (): void => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    void replayOutbox();
  };

  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") kick();
  });
  // A conflict resolution / explicit retry can also be triggered by others.
  window.addEventListener("morrow:outbox-replay", kick);
}

/**
 * Call once before the first bootstrap on launch. Guarded so StrictMode,
 * router preloads, and two UI triggers cannot run the queue twice.
 */
export function replayOutboxBeforeBootstrap(): Promise<ReplayResult> {
  installOutboxTriggers();
  if (!launchReplay) {
    launchReplay = replayOutbox();
  }
  return launchReplay;
}
// M2-OUTBOX-END
