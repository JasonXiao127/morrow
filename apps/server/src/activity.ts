/**
 * Activity log + undo (M3, plan §3 `activity` + §5 undo + §9 Recently Deleted).
 *
 * Row shape (DB `activity`):
 *   seq (AUTOINCREMENT cursor for SSE replay), batch_id, op_id, actor,
 *   actor_id, action, entity_type, entity_id, before_json, after_json,
 *   summary, created_at.
 *
 * Undo (`POST /api/activity/:id/undo`): single-op revert. The original row's
 * `before_json` is re-applied (rev bumped) and a new activity row
 * (`<action>.undo`, before/after swapped) is written. Supported entities:
 * `task(s)` and `list(s)`. Anything else (settings, backup runs, undo rows
 * themselves) is rejected with a 4xx `ActivityError`.
 */

export interface ActivityDbStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
}

export interface ActivityDb {
  prepare(sql: string): ActivityDbStatement;
  transaction<T>(fn: () => T): () => T;
}

export interface RecordActivityInput {
  batchId?: string | null;
  opId?: string | null;
  actor?: string | null;
  actorId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  /** Full row snapshot before the mutation (object, JSON string, or null). */
  before?: unknown;
  /** Full row snapshot after the mutation (object, JSON string, or null). */
  after?: unknown;
  summary?: string | null;
  createdAt?: string;
}

export interface ActivityRow {
  seq: number;
  batch_id: string | null;
  op_id: string | null;
  actor: string | null;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before_json: string | null;
  after_json: string | null;
  summary: string | null;
  created_at: string;
}

export class ActivityError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.name = "ActivityError";
    this.status = status;
    this.code = code;
  }
}

function toJsonText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function parseJsonLoose(text: string | null): unknown {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Append an activity row. Returns the new `seq` cursor.
 * Timestamps use UTC ISO with fixed milliseconds (§3).
 */
export function recordActivity(
  db: ActivityDb,
  input: RecordActivityInput,
): number {
  if (!input.action || typeof input.action !== "string") {
    throw new ActivityError(400, "invalid_activity", "Activity action is required.");
  }
  const createdAt = input.createdAt ?? nowIso();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)) {
    throw new ActivityError(
      400,
      "invalid_activity",
      "createdAt must be UTC ISO with fixed milliseconds.",
    );
  }
  const info = db
    .prepare(
      `INSERT INTO activity
         (batch_id, op_id, actor, actor_id, action, entity_type, entity_id,
          before_json, after_json, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.batchId ?? null,
      input.opId ?? null,
      input.actor ?? null,
      input.actorId ?? null,
      input.action,
      input.entityType ?? null,
      input.entityId ?? null,
      toJsonText(input.before),
      toJsonText(input.after),
      input.summary ?? null,
      createdAt,
    );
  return Number(info.lastInsertRowid);
}

export function getActivity(db: ActivityDb, seq: number): ActivityRow | null {
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;
  const row = db
    .prepare("SELECT * FROM activity WHERE seq = ?")
    .get(seq) as ActivityRow | undefined;
  return row ?? null;
}

export interface ListActivityOptions {
  cursor?: number;
  limit?: number;
  /** When set, only rows whose actor_id matches are returned (member scope). */
  actorId?: string;
  /** "asc" is the SSE replay primitive; "desc" is latest-first history. */
  order?: "asc" | "desc";
}

export interface ListActivityResult {
  rows: ActivityRow[];
  /** Cursor to pass back as `?cursor=` for SSE replay. */
  cursor: number;
}

/**
 * Activity history. Ascending (`seq > cursor`) is the SSE replay primitive;
 * descending (`seq < cursor`) returns the latest rows first, which is what the
 * activity/undo UI needs and avoids paging through the whole log.
 */
export function listActivity(
  db: ActivityDb,
  options: ListActivityOptions = {},
): ListActivityResult {
  const order = options.order === "desc" ? "desc" : "asc";
  const hasCursor =
    options.cursor !== undefined &&
    Number.isSafeInteger(options.cursor) &&
    options.cursor >= 0;
  const cursor = hasCursor
    ? options.cursor!
    : order === "desc"
      ? Number.MAX_SAFE_INTEGER
      : 0;
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const comparison = order === "desc" ? "<" : ">";
  const direction = order === "desc" ? "DESC" : "ASC";
  const where = [`seq ${comparison} ?`];
  const params: Array<number | string> = [cursor];
  if (options.actorId) {
    where.push("actor_id = ?");
    params.push(options.actorId);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM activity WHERE ${where.join(" AND ")} ORDER BY seq ${direction} LIMIT ?`,
    )
    .all(...params) as ActivityRow[];
  let next = cursor;
  for (const row of rows) {
    if (order === "desc" ? row.seq < next : row.seq > next) next = row.seq;
  }
  return { rows, cursor: next };
}

/**
 * Delete activity older than a cutoff in bounded batches. Activity is the
 * undo/audit log; keeping it bounded prevents the DB and JSON backups from
 * growing forever. Runs in the scheduler's daily maintenance window.
 */
export function pruneActivity(
  db: ActivityDb,
  options: { before: string; batchSize?: number },
): number {
  const batchSize = Math.min(Math.max(options.batchSize ?? 1_000, 1), 5_000);
  let total = 0;
  for (;;) {
    const info = db
      .prepare(
        `DELETE FROM activity WHERE seq IN (
           SELECT seq FROM activity WHERE created_at < ?
           ORDER BY seq ASC LIMIT ?
         )`,
      )
      .run(options.before, batchSize);
    const changes = Number(info.changes);
    total += changes;
    if (changes < batchSize) break;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

const UNDOABLE_TABLES = {
  task: "tasks",
  tasks: "tasks",
  list: "lists",
  lists: "lists",
} as const;

function tableForEntity(entityType: string | null): "tasks" | "lists" | null {
  if (!entityType) return null;
  return (UNDOABLE_TABLES as Record<string, "tasks" | "lists" | undefined>)[
    entityType.toLowerCase()
  ] ?? null;
}

function readEntityRow(
  db: ActivityDb,
  table: "tasks" | "lists",
  id: string,
): Record<string, unknown> | null {
  const row = db
    .prepare(`SELECT * FROM "${table}" WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ?? null;
}

const PROTECTED_UNDO_COLUMNS = new Set(["id"]);

/**
 * Exact writable columns per undoable table (mirrors the Drizzle schema:
 * every physical column except the identity/revision/clock columns, which
 * undo manages itself). Any other key in a stored snapshot is rejected
 * instead of being interpolated into SQL — a snapshot is attacker-influenced
 * data (sync/restore paths write it), so unknown keys must fail closed
 * rather than become identifiers.
 */
const UNDO_WRITABLE_COLUMNS: Record<"tasks" | "lists", ReadonlySet<string>> = {
  tasks: new Set([
    "user_id",
    "list_id",
    "title",
    "notes",
    "ical_uid",
    "caldav_href",
    "status",
    "priority",
    "due_at",
    "due_date",
    "all_day",
    "timezone",
    "remind_at",
    "reminder_time_local",
    "remind_offset_minutes",
    "snoozed_until",
    "dtstart_local",
    "next_occurrence_at",
    "next_occurrence_local",
    "occurrence_seq",
    "rrule",
    "recurrence_until_utc",
    "recurrence_until_date",
    "recurrence_count",
    "wkst",
    "recurrence_mode",
    "clamp_policy",
    "series_ended_at",
    "missed_count",
    "completed_at",
    "sort_key",
    "created_by",
    "updated_by",
    "deleted_at",
  ]),
  lists: new Set([
    "user_id",
    "name",
    "color",
    "icon",
    "sort_key",
    "is_inbox",
    "created_by",
    "updated_by",
    "deleted_at",
  ]),
};

const SAFE_COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolve the snapshot keys of one undo path to a quoted column list.
 * Unknown keys (e.g. `notes" = (SELECT …)` smuggled in via before_json)
 * throw instead of reaching string-interpolated SQL; values always travel
 * as bound parameters, so even hostile values land literally.
 */
function undoColumnsForSnapshot(
  table: "tasks" | "lists",
  snapshot: Record<string, unknown>,
  exclude: ReadonlySet<string>,
): string[] {
  const allowed = UNDO_WRITABLE_COLUMNS[table];
  const cols: string[] = [];
  for (const key of Object.keys(snapshot)) {
    if (exclude.has(key)) continue;
    if (!allowed.has(key) || !SAFE_COLUMN_RE.test(key)) {
      throw new ActivityError(
        400,
        "invalid_snapshot",
        `Undo snapshot contains a non-undoable column for ${table}: ${key.slice(0, 64)}.`,
      );
    }
    cols.push(key);
  }
  return cols;
}

interface MembershipSnapshot {
  userId: string;
  role: "owner" | "member";
}

function snapshotId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new ActivityError(
      400,
      "invalid_snapshot",
      `Undo snapshot is missing a valid ${label}.`,
    );
  }
  return value;
}

function membershipSnapshot(
  snapshot: Record<string, unknown> | null,
  label: string,
): MembershipSnapshot {
  if (!snapshot) {
    throw new ActivityError(
      400,
      "invalid_snapshot",
      `Undo snapshot is missing the ${label} membership.`,
    );
  }
  return {
    userId: snapshotId(snapshot["userId"], "membership user id"),
    role: snapshot["role"] === "owner" ? "owner" : "member",
  };
}

/**
 * list.delete journals the task ids it unlinked. Older rows have no journal;
 * they restore as an empty list (the previous behaviour) rather than failing.
 */
function memberTaskIdsForSnapshot(
  snapshot: Record<string, unknown> | null,
): string[] {
  const raw = snapshot?.["memberTaskIds"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 10_000) {
    throw new ActivityError(
      400,
      "invalid_snapshot",
      "Undo snapshot has an invalid member task journal.",
    );
  }
  const ids = new Set<string>();
  for (const entry of raw) {
    ids.add(snapshotId(entry, "member task id"));
  }
  return [...ids];
}

function snapshotWithoutMembershipJournal(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const copy = { ...snapshot };
  delete copy["memberTaskIds"];
  return copy;
}

/** A permanent purge after the recorded action closes the undo window. */
function wasPurgedAfter(
  db: ActivityDb,
  original: ActivityRow,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS found FROM activity
        WHERE entity_type = ? AND entity_id = ?
          AND action LIKE '%.purge' AND seq > ?
        LIMIT 1`,
    )
    .get(original.entity_type, original.entity_id, original.seq) as
    | { found: number }
    | undefined;
  return Boolean(row);
}

function assertAfterRevision(
  current: Record<string, unknown>,
  afterRow: Record<string, unknown> | null,
): void {
  const afterRev = afterRow?.["rev"];
  if (
    typeof afterRev === "number" &&
    typeof current["rev"] === "number" &&
    current["rev"] !== afterRev
  ) {
    throw new ActivityError(
      409,
      "undo_conflict",
      `Row changed since (rev ${current["rev"]} ≠ recorded ${afterRev}); refresh and retry.`,
    );
  }
}

/**
 * Restore one row from a before snapshot (delete/undo path). The row is
 * updated in place when it still exists, otherwise re-inserted. Identity and
 * clocks are never taken blindly: `rev` is bumped and `updated_at` is now.
 */
function restoreRowFromSnapshot(
  db: ActivityDb,
  table: "tasks" | "lists",
  id: string,
  snapshot: Record<string, unknown>,
  now: string,
): Record<string, unknown> {
  const cols = undoColumnsForSnapshot(
    table,
    snapshot,
    new Set([
      ...PROTECTED_UNDO_COLUMNS,
      "rev",
      "updated_at",
      "created_at",
      "deleted_at",
    ]),
  );
  const current = readEntityRow(db, table, id);
  if (current) {
    if (cols.length > 0) {
      db.prepare(
        `UPDATE "${table}" SET ${cols.map((c) => `"${c}" = ?`).join(", ")} WHERE id = ?`,
      ).run(...cols.map((c) => snapshot[c] ?? null), id);
    }
    db.prepare(
      `UPDATE "${table}" SET deleted_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?`,
    ).run((snapshot["deleted_at"] ?? null) as string | null, now, id);
    return readEntityRow(db, table, id) ?? {};
  }

  const nextRev =
    typeof snapshot["rev"] === "number" ? (snapshot["rev"] as number) + 1 : 1;
  const createdAt =
    typeof snapshot["created_at"] === "string"
      ? (snapshot["created_at"] as string)
      : now;
  const insertCols = [...cols, "created_at", "rev", "updated_at", "deleted_at"];
  db.prepare(
    `INSERT INTO "${table}" (id${insertCols.length > 0 ? ", " + insertCols.map((c) => `"${c}"`).join(", ") : ""})
     VALUES (?${insertCols.length > 0 ? ", " + insertCols.map(() => "?").join(", ") : ""})`,
  ).run(
    id,
    ...cols.map((c) => snapshot[c] ?? null),
    createdAt,
    nextRev,
    now,
    (snapshot["deleted_at"] ?? null) as string | null,
  );
  return readEntityRow(db, table, id) ?? {};
}

export interface UndoOptions {
  actor?: string | null;
  actorId?: string | null;
  batchId?: string | null;
  opId?: string | null;
}

export interface UndoResult {
  /** The original (undone) activity seq. */
  undoneSeq: number;
  /** The new `.undo` activity seq. */
  seq: number;
  entityType: string;
  entityId: string;
  row: Record<string, unknown>;
}

function completionIdFromSnapshot(
  afterRow: Record<string, unknown> | null,
): string | null {
  const completion = afterRow?.["completion"];
  if (isRecord(completion) && typeof completion["id"] === "string") {
    return snapshotId(completion["id"], "completion id");
  }
  return null;
}

/**
 * Older task.complete/task.skip rows predate the completion snapshot. Recover
 * the exact row from the task's occurrence key (or its completion instant)
 * instead of deleting an arbitrary recent completion.
 */
function legacyCompletionId(
  db: ActivityDb,
  action: string,
  taskId: string,
  beforeRow: Record<string, unknown>,
  afterRow: Record<string, unknown> | null,
): string | null {
  const occurrenceKey =
    (typeof beforeRow["next_occurrence_at"] === "string"
      ? beforeRow["next_occurrence_at"]
      : undefined) ??
    (typeof beforeRow["due_at"] === "string" ? beforeRow["due_at"] : undefined) ??
    (typeof beforeRow["due_date"] === "string"
      ? String(beforeRow["due_date"]).slice(0, 10)
      : undefined);
  const completedAt =
    afterRow && typeof afterRow["completed_at"] === "string"
      ? afterRow["completed_at"]
      : null;
  if (!occurrenceKey && !completedAt) return null;
  const status = action === "task.skip" ? "skipped" : "completed";
  const row = db
    .prepare(
      `SELECT id FROM task_completions
        WHERE task_id = ? AND deleted_at IS NULL AND status = ?
          AND (? IS NULL OR occurrence_key = ?)
          AND (? IS NULL OR completed_at = ?)
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(
      taskId,
      status,
      occurrenceKey ?? null,
      occurrenceKey ?? null,
      completedAt,
      completedAt,
    ) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Revert a single activity op. The reverted row gets `rev + 1` and a fresh
 * `updated_at`; a new `<action>.undo` activity row links the two (the log is
 * append-only — undo never deletes history).
 *
 * Conflict rule (same spirit as §5 `If-Match`): reverting an *update*
 * requires the live row's `rev` to still equal the recorded `after.rev`;
 * otherwise someone changed the row since and undo fails with 409.
 *
 * Action-specific paths keep side effects exact:
 *  - list.share/list.unshare touch only `list_members` (never the list row);
 *  - task.complete/task.skip also soft-delete the exact completion row;
 *  - task.delete/list.delete restore the row (and list task memberships);
 *  - *.purge is explicitly outside the undo window.
 */
export function undoActivity(
  db: ActivityDb,
  seq: number,
  options: UndoOptions = {},
): UndoResult {
  const original = getActivity(db, seq);
  if (!original) {
    throw new ActivityError(404, "not_found", `No activity row with seq ${seq}.`);
  }
  if (original.action.endsWith(".undo")) {
    throw new ActivityError(
      409,
      "already_undone",
      "Undo rows cannot be undone (the log is append-only).",
    );
  }
  if (original.action.endsWith(".purge")) {
    throw new ActivityError(
      409,
      "purge_not_undoable",
      `Action "${original.action}" permanently deleted the row and cannot be undone.`,
    );
  }
  const table = tableForEntity(original.entity_type);
  if (!table || !original.entity_id) {
    throw new ActivityError(
      400,
      "not_undoable",
      `Action "${original.action}" on "${original.entity_type ?? "unknown"}" cannot be undone (only task/list ops).`,
    );
  }

  const action = original.action;
  const entityId = original.entity_id as string;
  const before = parseJsonLoose(original.before_json);
  const after = parseJsonLoose(original.after_json);
  const beforeRow = isRecord(before) ? before : null;
  const afterRow = isRecord(after) ? after : null;
  if (beforeRow === null && afterRow === null) {
    throw new ActivityError(
      400,
      "not_undoable",
      "Activity row has no before/after snapshot to revert.",
    );
  }

  const now = nowIso();
  const run = db.transaction(() => {
    const current = readEntityRow(db, table, entityId);
    let reverted: Record<string, unknown>;
    let auditAfter: unknown;

    if (action === "list.share" || action === "list.unshare") {
      if (!current) {
        throw new ActivityError(
          409,
          "not_undoable",
          "The list no longer exists; its membership cannot be changed.",
        );
      }
      const member = membershipSnapshot(
        action === "list.share" ? afterRow : beforeRow,
        action,
      );
      const existing = db
        .prepare(
          "SELECT 1 AS found FROM list_members WHERE list_id = ? AND user_id = ?",
        )
        .get(entityId, member.userId) as { found: number } | undefined;
      if (action === "list.share") {
        if (!existing) {
          throw new ActivityError(
            409,
            "already_undone",
            "That list membership was already removed; nothing to undo.",
          );
        }
        db.prepare(
          "DELETE FROM list_members WHERE list_id = ? AND user_id = ?",
        ).run(entityId, member.userId);
        auditAfter = { userId: member.userId, present: false };
      } else {
        if (existing) {
          throw new ActivityError(
            409,
            "already_restored",
            "That list membership is already present; nothing to restore.",
          );
        }
        db.prepare(
          `INSERT INTO list_members (list_id, user_id, role, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(entityId, member.userId, member.role, now);
        auditAfter = {
          userId: member.userId,
          role: member.role,
          present: true,
        };
      }
      reverted = readEntityRow(db, table, entityId) ?? current;
    } else if (action === "task.complete" || action === "task.skip") {
      if (!beforeRow) {
        throw new ActivityError(
          400,
          "invalid_snapshot",
          "Completion undo is missing the prior task snapshot.",
        );
      }
      if (!current || current["deleted_at"] != null) {
        throw new ActivityError(
          409,
          "already_deleted",
          "Row is deleted; restore it from trash before undoing the completion.",
        );
      }
      assertAfterRevision(current, afterRow);
      const explicitId = completionIdFromSnapshot(afterRow);
      const completionId =
        explicitId ??
        legacyCompletionId(db, action, entityId, beforeRow, afterRow);
      if (completionId) {
        const info = db
          .prepare(
            `UPDATE task_completions
                SET deleted_at = ?, rev = rev + 1
              WHERE id = ? AND task_id = ? AND deleted_at IS NULL`,
          )
          .run(now, completionId, entityId);
        if (explicitId && Number(info.changes) === 0) {
          throw new ActivityError(
            409,
            "already_undone",
            "The completion was already undone; nothing to revert.",
          );
        }
      }
      reverted = restoreRowFromSnapshot(db, table, entityId, beforeRow, now);
      auditAfter = reverted;
    } else if (action === "task.delete" || action === "list.delete") {
      if (!beforeRow) {
        throw new ActivityError(
          400,
          "invalid_snapshot",
          "Delete undo is missing the prior row snapshot.",
        );
      }
      if (wasPurgedAfter(db, original)) {
        throw new ActivityError(
          409,
          "purge_not_undoable",
          "This item was permanently deleted after that action; it cannot be restored.",
        );
      }
      if (current && current["deleted_at"] == null) {
        throw new ActivityError(
          409,
          "already_restored",
          "Row is already restored; nothing to undo.",
        );
      }
      const snapshot =
        action === "list.delete"
          ? snapshotWithoutMembershipJournal(beforeRow)
          : beforeRow;
      reverted = restoreRowFromSnapshot(db, table, entityId, snapshot, now);
      if (action === "list.delete") {
        // Every journaled member returns, including tasks created by shared
        // list members (their user_id differs from the list owner's).
        for (const taskId of memberTaskIdsForSnapshot(beforeRow)) {
          db.prepare(
            `UPDATE tasks
                SET list_id = ?, rev = rev + 1, updated_at = ?
              WHERE id = ? AND list_id IS NULL AND deleted_at IS NULL`,
          ).run(entityId, now, taskId);
        }
      }
      auditAfter = reverted;
    } else if (beforeRow === null && afterRow !== null) {
      // Create → undo by soft-deleting.
      if (!current || current["deleted_at"] != null) {
        throw new ActivityError(
          409,
          "already_deleted",
          "Row is already deleted; nothing to undo.",
        );
      }
      db.prepare(
        `UPDATE "${table}" SET deleted_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?`,
      ).run(now, now, entityId);
      reverted = readEntityRow(db, table, entityId) ?? {};
      auditAfter = reverted;
    } else if (beforeRow !== null && afterRow === null) {
      // Delete → undo by restoring.
      if (wasPurgedAfter(db, original)) {
        throw new ActivityError(
          409,
          "purge_not_undoable",
          "This item was permanently deleted after that action; it cannot be restored.",
        );
      }
      if (current && current["deleted_at"] == null) {
        throw new ActivityError(
          409,
          "already_restored",
          "Row is already restored; nothing to undo.",
        );
      }
      reverted = restoreRowFromSnapshot(db, table, entityId, beforeRow, now);
      auditAfter = reverted;
    } else if (beforeRow !== null && afterRow !== null) {
      // Update → undo by re-applying the before snapshot.
      if (!current || current["deleted_at"] != null) {
        throw new ActivityError(
          409,
          "already_deleted",
          "Row is deleted; restore it from trash before undoing the update.",
        );
      }
      assertAfterRevision(current, afterRow);
      const setCols = undoColumnsForSnapshot(
        table,
        beforeRow,
        new Set([
          ...PROTECTED_UNDO_COLUMNS,
          "rev",
          "updated_at",
          "created_at",
        ]),
      );
      if (setCols.length > 0) {
        db.prepare(
          `UPDATE "${table}" SET ${setCols.map((c) => `"${c}" = ?`).join(", ")} WHERE id = ?`,
        ).run(
          ...setCols.map((c) => beforeRow[c] ?? null),
          entityId,
        );
      }
      db.prepare(
        `UPDATE "${table}" SET deleted_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?`,
      ).run(
        (beforeRow["deleted_at"] ?? null) as string | null,
        now,
        entityId,
      );
      reverted = readEntityRow(db, table, entityId) ?? {};
      auditAfter = reverted;
    } else {
      throw new ActivityError(
        400,
        "not_undoable",
        "Activity row has no usable before/after snapshot.",
      );
    }

    const undoSeq = recordActivity(db, {
      batchId: options.batchId ?? original.batch_id,
      opId: options.opId ?? null,
      actor: options.actor ?? "user",
      actorId: options.actorId ?? null,
      action: `${original.action}.undo`,
      entityType: original.entity_type,
      entityId,
      before: original.after_json,
      after: auditAfter ?? reverted,
      summary: `Undo ${original.action} on ${original.entity_type} ${entityId}`,
      createdAt: now,
    });

    return { undoSeq, reverted };
  });

  let result: { undoSeq: number; reverted: Record<string, unknown> };
  try {
    result = run();
  } catch (err) {
    // A restored row can collide with a UID/href or list identity created
    // since the delete. Surface a typed undo conflict instead of a raw 500.
    if (
      err instanceof Error &&
      /(UNIQUE|FOREIGN KEY) constraint failed/.test(err.message) &&
      !(err instanceof ActivityError)
    ) {
      throw new ActivityError(
        409,
        "undo_conflict",
        "Undo would duplicate an identity that was created after the change. Resolve the duplicate and retry.",
      );
    }
    throw err;
  }
  const { undoSeq, reverted } = result;
  return {
    undoneSeq: seq,
    seq: undoSeq,
    entityType: original.entity_type as string,
    entityId,
    row: reverted,
  };
}

/** API/SSE shape for an activity row (before/after parsed best-effort). */
export function activityToJson(row: ActivityRow): Record<string, unknown> {
  return {
    seq: row.seq,
    batchId: row.batch_id,
    opId: row.op_id,
    actor: row.actor,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: parseJsonLoose(row.before_json),
    after: parseJsonLoose(row.after_json),
    summary: row.summary,
    createdAt: row.created_at,
  };
}
