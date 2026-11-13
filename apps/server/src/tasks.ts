/**
 * M1 tasks API (§5 contract, §9 views, §11 M1).
 *
 *   POST   /api/tasks                       create; client UUID idempotent
 *   GET    /api/tasks?view=...              today|upcoming|inbox|all + cursor
 *   GET    /api/tasks/:id                   ETag "rev-N"
 *   PATCH  /api/tasks/:id                   requires If-Match (428/412)
 *   DELETE /api/tasks/:id                   soft delete; requires If-Match
 *   POST   /api/tasks/:id/complete          occurrenceKey idempotent; If-Match
 *   POST   /api/tasks/:id/snooze            requires If-Match
 *   POST   /api/tasks/:id/skip              occurrenceKey idempotent; If-Match
 *
 * View semantics mirror the PWA grouping (§9): a task's day key is the
 * all-day `due_date`, else the local date of `next_occurrence_at|due_at` in
 * the user's timezone, else `due_date`. Today = open tasks with day ≤ today
 * (overdue included); upcoming = day > today; inbox = no day key. Done tasks
 * never appear in the three smart views.
 *
 * Recurring completes advance the series with the shared engine
 * (`nextOccurrenceForMode`); one-shots flip to done/cancelled. Scheduler
 * catch-up and delivery enqueue stay M2; M1 cancels pending deliveries on
 * complete/snooze/skip/delete.
 */
import crypto from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "@morrow/db";
import {
  applyReminderOffset,
  assertValidRecurrence,
  clampPolicySchema,
  deriveReminder,
  etagForRev,
  initialSortKey,
  isOccurrenceKey,
  isUtcIso,
  newId,
  nextOccurrenceForMode,
  normalizeWallTime,
  nowIso,
  parseIfMatch,
  problem,
  recurrenceModeSchema,
  resolveWallTime,
  taskCreateSchema,
  taskStatusSchema,
  timezoneSchema,
  utcIsoSchema,
  uuidSchema,
  wallDateOrDateTimeSchema,
  wallDateSchema,
  wallTimeSchema,
  weekdaySchema,
  type RecurrenceInput,
  type RecurrenceMode,
} from "@morrow/shared";
import { TASK_ACCESS_SQL, canAccessList } from "./access.js";
import { authenticateRequest } from "./auth.js";
import { cancelPendingDeliveriesForTask } from "./deliveries.js";
import {
  badRequest,
  notFound,
  preconditionRequired,
  sendProblem,
  unauthorized,
} from "./errors.js";

export interface TaskRow {
  id: string;
  user_id: string;
  list_id: string | null;
  title: string;
  notes: string | null;
  ical_uid: string | null;
  caldav_href: string | null;
  status: string;
  priority: number;
  due_at: string | null;
  due_date: string | null;
  all_day: number | boolean;
  timezone: string | null;
  remind_at: string | null;
  reminder_time_local: string | null;
  remind_offset_minutes: number | null;
  snoozed_until: string | null;
  dtstart_local: string | null;
  next_occurrence_at: string | null;
  next_occurrence_local: string | null;
  occurrence_seq: number;
  rrule: string | null;
  recurrence_until_utc: string | null;
  recurrence_until_date: string | null;
  recurrence_count: number | null;
  wkst: string | null;
  recurrence_mode: string;
  clamp_policy: string;
  series_ended_at: string | null;
  missed_count: number;
  completed_at: string | null;
  sort_key: string;
  created_by: string | null;
  updated_by: string | null;
  rev: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface CompletionRow {
  id: string;
  task_id: string;
  occurrence_key: string;
  status: string;
  completed_at: string | null;
  source: string;
  rev: number;
  created_at: string;
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// Local M1 helpers (self-contained; routes.ts stays append-only)
// ---------------------------------------------------------------------------

function authed(req: FastifyRequest, reply: FastifyReply) {
  const auth = authenticateRequest(req);
  if (!auth) {
    unauthorized(req, reply);
    return null;
  }
  return auth;
}

interface ConflictCurrent {
  id: string;
  rev: number;
  updatedAt: string;
  title: string;
}

function conflictCurrent(t: TaskRow): ConflictCurrent {
  return {
    id: t.id,
    rev: t.rev,
    updatedAt: t.updated_at,
    title: t.title,
  };
}

/**
 * 409/412 responses carry the current compact representation + strong ETag so
 * the client conflict resolver can reload/overwrite without another fetch
 * (§5 concurrency).
 */
function sendCurrentProblem(
  req: FastifyRequest,
  reply: FastifyReply,
  status: 409 | 412,
  code: string,
  detail: string,
  current: ConflictCurrent,
): FastifyReply {
  const traceId = (req.id ?? "") as string;
  return reply
    .code(status)
    .header("content-type", "application/problem+json")
    .header("cache-control", "no-store")
    .header("ETag", etagForRev(current.rev))
    .send({
      ...problem(status, status === 409 ? "Conflict" : "Precondition Failed", {
        detail,
        code,
        ...(traceId ? { traceId } : {}),
      }),
      current,
    });
}

function checkIfMatch(
  req: FastifyRequest,
  reply: FastifyReply,
  current: ConflictCurrent,
): boolean {
  const raw = req.headers["if-match"];
  if (raw === undefined) {
    preconditionRequired(req, reply);
    return false;
  }
  const want = parseIfMatch(raw);
  if (want === null || want !== current.rev) {
    sendCurrentProblem(
      req,
      reply,
      412,
      "stale_revision",
      `Stale revision. Current rev is ${current.rev}.`,
      current,
    );
    return false;
  }
  return true;
}

function idempotencyKey(req: FastifyRequest): string | null {
  const v = req.headers["idempotency-key"];
  if (typeof v !== "string" || v.trim() === "") return null;
  if (v.length > 128) return null;
  return v.trim();
}

function sha256Json(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface OperationCache {
  result_json: string;
  payload_hash: string | null;
}

function lookupOperation(opId: string): OperationCache | null {
  try {
    const row = getDb()
      .prepare("SELECT result_json, payload_hash FROM operations WHERE op_id = ?")
      .get(opId) as OperationCache | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function storeOperationTx(opts: {
  opId: string;
  kind: string;
  entityId: string | null;
  baseRev: number | null;
  payloadHash: string | null;
  result: unknown;
}): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO operations
         (op_id, kind, entity_id, base_rev, payload_hash, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.opId,
      opts.kind,
      opts.entityId,
      opts.baseRev,
      opts.payloadHash,
      JSON.stringify(opts.result),
      nowIso(),
    );
}

function writeActivityTx(opts: {
  batchId: string;
  opId: string | null;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  summary: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO activity
         (batch_id, op_id, actor, actor_id, action, entity_type,
          entity_id, before_json, after_json, summary, created_at)
       VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.batchId,
      opts.opId,
      opts.actorId,
      opts.action,
      opts.entityType,
      opts.entityId,
      JSON.stringify(opts.before ?? null),
      JSON.stringify(opts.after ?? null),
      opts.summary,
      nowIso(),
    );
}

/**
 * M2 owns enqueue; a state change cancels what is still pending/retrying so a
 * completed/snoozed/skipped/deleted task cannot fire a stale reminder.
 * Returns the number of rows removed for the activity summary.
 */
function cancelPendingDeliveriesTx(taskId: string): number {
  try {
    const info = getDb()
      .prepare(
        `DELETE FROM deliveries
          WHERE task_id = ? AND status IN ('pending', 'retry')`,
      )
      .run(taskId);
    return Number(info.changes);
  } catch {
    // Deliveries lifecycle is M2; cancellation is best-effort here.
    return 0;
  }
}

/** M2 SSE fan-out hook. No-op until the activity feed lands. */
function publishAfterCommit(_event: {
  type: string;
  entityKind: string;
  entityId: string;
  rev: number;
}): void {
  // M2 subscribes here; M1 clients re-bootstrap or re-query the view.
}

function gone(req: FastifyRequest, reply: FastifyReply, what: string) {
  return sendProblem(req, reply, 410, "Gone", {
    detail: `${what} was deleted.`,
    code: "gone",
  });
}

function getTask(userId: string, id: string): TaskRow | null {
  const row = getDb()
    .prepare(
      `SELECT t.* FROM tasks t
        WHERE t.id = ? AND (${TASK_ACCESS_SQL})`,
    )
    .get(id, userId, userId, userId) as TaskRow | undefined;
  return row ?? null;
}

function getCompletion(taskId: string, occurrenceKey: string): CompletionRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM task_completions
        WHERE task_id = ? AND occurrence_key = ? AND deleted_at IS NULL`,
    )
    .get(taskId, occurrenceKey) as CompletionRow | undefined;
  return row ?? null;
}

function liveList(userId: string, listId: string): boolean {
  return canAccessList(userId, listId);
}

/**
 * Moving a task between collections keeps its CalDAV identity. A live row in
 * the target collection with the same UID or href would violate the
 * per-collection unique indexes; return the conflict for a typed 409 instead
 * of letting SQLite turn it into an opaque 500.
 */
function targetIdentityConflict(
  task: TaskRow,
  targetListId: string | null,
): { field: "ical_uid" | "caldav_href"; existingHref: string } | null {
  const db = getDb();
  const scope =
    targetListId === null
      ? `t.user_id = ? AND (t.list_id IS NULL OR t.list_id = (
           SELECT il.id FROM lists il
            WHERE il.user_id = t.user_id AND il.is_inbox = 1
              AND il.deleted_at IS NULL
            LIMIT 1
         ))`
      : "t.list_id = ?";
  const scopeParam = targetListId ?? task.user_id;
  const row = db
    .prepare(
      `SELECT t.id, COALESCE(t.caldav_href, t.id || '.ics') AS href,
              (? IS NOT NULL AND t.ical_uid = ?) AS uid_match
         FROM tasks t
        WHERE t.id <> ? AND t.deleted_at IS NULL AND ${scope}
          AND ((? IS NOT NULL AND t.ical_uid = ?)
            OR (? IS NOT NULL AND t.caldav_href = ?))
        LIMIT 1`,
    )
    .get(
      task.ical_uid,
      task.ical_uid,
      task.id,
      scopeParam,
      task.ical_uid,
      task.ical_uid,
      task.caldav_href,
      task.caldav_href,
    ) as { id: string; href: string; uid_match: number } | undefined;
  if (row) {
    return {
      field: row.uid_match === 1 ? "ical_uid" : "caldav_href",
      existingHref: row.href,
    };
  }

  // Base resources and recurrence exceptions share one collection href
  // namespace. Moving a series carries its exception hrefs with it.
  const hrefExists = db.prepare(
    `SELECT 1 AS found FROM tasks t
      WHERE t.id <> ? AND t.deleted_at IS NULL AND ${scope}
        AND t.caldav_href = ?
     UNION ALL
     SELECT 1 AS found FROM tasks t
       JOIN task_recurrence_exceptions xe
         ON xe.task_id = t.id AND xe.deleted_at IS NULL
      WHERE t.id <> ? AND t.deleted_at IS NULL AND ${scope}
        AND xe.caldav_href = ?
     LIMIT 1`,
  );
  const hrefConflict = (href: string): boolean =>
    Boolean(
      hrefExists.get(task.id, scopeParam, href, task.id, scopeParam, href),
    );
  if (task.caldav_href && hrefConflict(task.caldav_href)) {
    return { field: "caldav_href", existingHref: task.caldav_href };
  }
  const exceptions = db
    .prepare(
      `SELECT caldav_href FROM task_recurrence_exceptions
        WHERE task_id = ? AND deleted_at IS NULL`,
    )
    .all(task.id) as Array<{ caldav_href: string }>;
  for (const exception of exceptions) {
    if (hrefConflict(exception.caldav_href)) {
      return { field: "caldav_href", existingHref: exception.caldav_href };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Day keys / views (§9) — same rule as the PWA grouping, server side.
// ---------------------------------------------------------------------------

const tzFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(tz: string): Intl.DateTimeFormat {
  let f = tzFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    tzFormatters.set(tz, f);
  }
  return f;
}

export function dayKeyInTz(instantIso: string, tz: string): string | null {
  const ms = Date.parse(instantIso);
  if (Number.isNaN(ms)) return null;
  try {
    return dayFormatter(tz).format(new Date(ms));
  } catch {
    return dayFormatter("UTC").format(new Date(ms));
  }
}

export function todayKeyInTz(tz: string, now: Date = new Date()): string {
  try {
    return dayFormatter(tz).format(now);
  } catch {
    return dayFormatter("UTC").format(now);
  }
}

interface ScheduleFields {
  all_day: number | boolean;
  rrule: string | null;
  next_occurrence_local: string | null;
  next_occurrence_at: string | null;
  due_at: string | null;
  due_date: string | null;
}

function isAllDay(t: ScheduleFields): boolean {
  return t.all_day === 1 || t.all_day === true;
}

/**
 * Mirrors web `taskDayKey`: an all-day recurring series follows its next
 * occurrence date (`next_occurrence_local`), not the immutable series
 * `due_date`; other all-day tasks use `due_date`, else the local date of the
 * next instant.
 */
function effectiveDayKeyFor(t: ScheduleFields, tz: string): string | null {
  if (isAllDay(t)) {
    if (t.rrule && t.next_occurrence_local) {
      return t.next_occurrence_local.slice(0, 10);
    }
    if (t.due_date) return t.due_date.slice(0, 10);
  }
  const instant = t.next_occurrence_at ?? t.due_at;
  if (instant) return dayKeyInTz(instant, tz);
  if (t.due_date) return t.due_date.slice(0, 10);
  return null;
}

export function effectiveDayKey(t: TaskRow, tz: string): string | null {
  return effectiveDayKeyFor(t, tz);
}

function sortInstantMsFor(t: ScheduleFields): number | null {
  if (isAllDay(t) && t.rrule && t.next_occurrence_local) {
    const ms = Date.parse(`${t.next_occurrence_local.slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(ms)) return ms;
  }
  const instant = t.next_occurrence_at ?? t.due_at;
  if (instant) {
    const ms = Date.parse(instant);
    if (!Number.isNaN(ms)) return ms;
  }
  if (t.due_date) {
    const ms = Date.parse(`${t.due_date.slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

/**
 * SQLite has no timezone-aware date arithmetic, so the task list registers
 * these two deterministic helpers on its connection. Keeping the view/day-key
 * and sort-instant rules here (instead of reimplementing them in SQL) means
 * GET /api/tasks can filter, order, and limit in SQLite and still match the
 * PWA grouping exactly, including all-day recurring series.
 */
const TASK_DAY_KEY_FN = "morrow_task_day_key";
const TASK_SORT_MS_FN = "morrow_task_sort_ms";
const taskQueryFunctionDbs = new WeakSet<object>();

function scheduleFieldsFromSql(args: unknown[]): ScheduleFields {
  const text = (value: unknown): string | null =>
    typeof value === "string" ? value : null;
  return {
    all_day: Number(args[0] ?? 0),
    rrule: text(args[1]),
    next_occurrence_local: text(args[2]),
    due_date: text(args[3]),
    next_occurrence_at: text(args[4]),
    due_at: text(args[5]),
  };
}

function taskDayKeySql(
  allDay: unknown,
  rrule: unknown,
  nextLocal: unknown,
  dueDate: unknown,
  nextAt: unknown,
  dueAt: unknown,
  tz: unknown,
): string | null {
  const fields = scheduleFieldsFromSql([
    allDay,
    rrule,
    nextLocal,
    dueDate,
    nextAt,
    dueAt,
  ]);
  const zone = typeof tz === "string" && tz ? tz : "UTC";
  return effectiveDayKeyFor(fields, zone);
}

function taskSortMsSql(
  allDay: unknown,
  rrule: unknown,
  nextLocal: unknown,
  dueDate: unknown,
  nextAt: unknown,
  dueAt: unknown,
): number | null {
  return sortInstantMsFor(
    scheduleFieldsFromSql([
      allDay,
      rrule,
      nextLocal,
      dueDate,
      nextAt,
      dueAt,
    ]),
  );
}

function ensureTaskQueryFunctions(db: ReturnType<typeof getDb>): void {
  if (taskQueryFunctionDbs.has(db)) return;
  // better-sqlite3 derives the SQL arity from the callback's `.length`, so
  // these stay as declared functions (not rest-argument closures).
  db.function(TASK_DAY_KEY_FN, { deterministic: true }, taskDayKeySql);
  db.function(TASK_SORT_MS_FN, { deterministic: true }, taskSortMsSql);
  taskQueryFunctionDbs.add(db);
}

/**
 * Cursor contract shared by task views and search (§5): `{items,cursor,next}`
 * where `cursor`/`next` are the same opaque next-page token (null at the end).
 * Legacy `tasks`/`nextCursor` aliases keep older clients readable.
 */
function taskPageBody(
  items: TaskRow[],
  next: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    items,
    cursor: next,
    next,
    hasMore: next !== null,
    ...extra,
    tasks: items,
    nextCursor: next,
  };
}

// ---------------------------------------------------------------------------
// Recurrence advance on complete/skip
// ---------------------------------------------------------------------------

function toRecurrenceInput(
  t: TaskRow,
  fallbackTz: string,
): RecurrenceInput | null {
  if (!t.rrule || !t.dtstart_local) return null;
  const tz = t.timezone ?? fallbackTz;
  return {
    rrule: t.rrule,
    dtstartLocal: t.dtstart_local,
    timezone: tz,
    count: t.recurrence_count,
    untilUtc: t.recurrence_until_utc,
    untilDate: t.recurrence_until_date,
    wkst: t.wkst,
    clampPolicy: (t.clamp_policy === "last-day" ? "last-day" : "skip") as
      | "skip"
      | "last-day",
    allDay: isAllDay(t),
    reminderTimeLocal: t.reminder_time_local,
  };
}

function checkRecurrence(
  t: TaskRow,
  fallbackTz: string,
): string | null {
  const input = toRecurrenceInput(t, fallbackTz);
  if (!input) return null;
  try {
    assertValidRecurrence(input);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "invalid recurrence";
  }
}

/** Default occurrence key: current scheduled instant, else today (user tz). */
function defaultOccurrenceKey(t: TaskRow, userTz: string): string {
  if (isAllDay(t) && t.next_occurrence_local) {
    return t.next_occurrence_local.slice(0, 10);
  }
  if (t.next_occurrence_at && isUtcIso(t.next_occurrence_at)) {
    return t.next_occurrence_at;
  }
  if (t.due_at && isUtcIso(t.due_at)) return t.due_at;
  if (t.due_date) return t.due_date.slice(0, 10);
  return todayKeyInTz(userTz);
}

interface AdvanceResult {
  ended: boolean;
  nextAt: string | null;
  nextLocal: string | null;
  seq: number;
}

/**
 * Advance a recurring task past `occurrenceKey`. Returns null for one-shots
 * (or when the stored rule no longer parses, so completion stays available).
 */
function advanceSeries(
  t: TaskRow,
  userTz: string,
  occurrenceKey: string,
  completedAtIso: string,
): AdvanceResult | null {
  const input = toRecurrenceInput(t, userTz);
  if (!input) return null;
  const tz = t.timezone ?? userTz;
  let occurrenceInstant: string;
  if (isUtcIso(occurrenceKey)) {
    occurrenceInstant = occurrenceKey;
  } else {
    try {
      const time = normalizeWallTime(t.reminder_time_local ?? "09:00:00");
      occurrenceInstant = resolveWallTime(`${occurrenceKey}T${time}`, tz).instantIso;
    } catch {
      return null;
    }
  }
  try {
    const mode: RecurrenceMode =
      t.recurrence_mode === "completion" ? "completion" : "schedule";
    const next = nextOccurrenceForMode(input, {
      mode,
      occurrenceInstant,
      completedAt: completedAtIso,
    });
    if (!next) {
      return { ended: true, nextAt: null, nextLocal: null, seq: t.occurrence_seq };
    }
    return {
      ended: false,
      nextAt: next.allDay ? null : next.instantIso,
      nextLocal: next.allDay ? next.local : next.wall,
      seq: next.index,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PATCH validation (shape only; cross-field checks run against the merged row)
// ---------------------------------------------------------------------------

const taskPatchSchema = z.object({
  title: z.string().trim().min(1).max(1000).optional(),
  notes: z.string().max(100_000).nullable().optional(),
  status: taskStatusSchema.optional(),
  priority: z.number().int().min(0).max(4).optional(),
  listId: uuidSchema.nullable().optional(),
  dueAt: utcIsoSchema.nullable().optional(),
  dueDate: wallDateSchema.nullable().optional(),
  allDay: z.boolean().optional(),
  timezone: timezoneSchema.nullable().optional(),
  remindAt: utcIsoSchema.nullable().optional(),
  reminderTimeLocal: wallTimeSchema.nullable().optional(),
  remindOffsetMinutes: z.number().int().min(-43_200).max(43_200).nullable().optional(),
  snoozedUntil: utcIsoSchema.nullable().optional(),
  dtstartLocal: wallDateOrDateTimeSchema.nullable().optional(),
  nextOccurrenceAt: utcIsoSchema.nullable().optional(),
  nextOccurrenceLocal: wallDateOrDateTimeSchema.nullable().optional(),
  occurrenceSeq: z.number().int().min(0).optional(),
  rrule: z.string().trim().min(1).max(2000).nullable().optional(),
  recurrenceUntilUtc: utcIsoSchema.nullable().optional(),
  recurrenceUntilDate: wallDateSchema.nullable().optional(),
  recurrenceCount: z.number().int().min(1).max(100_000).nullable().optional(),
  wkst: weekdaySchema.nullable().optional(),
  recurrenceMode: recurrenceModeSchema.optional(),
  clampPolicy: clampPolicySchema.optional(),
  seriesEndedAt: utcIsoSchema.nullable().optional(),
  missedCount: z.number().int().min(0).optional(),
  completedAt: utcIsoSchema.nullable().optional(),
  sortKey: z.string().min(1).max(64).optional(),
  baseRev: z.number().int().positive().optional(),
});

type TaskPatch = z.infer<typeof taskPatchSchema>;

interface MergedTask {
  recurrence_count: number | null;
  recurrence_until_utc: string | null;
  recurrence_until_date: string | null;
  all_day: boolean;
  due_date: string | null;
  due_at: string | null;
  rrule: string | null;
  dtstart_local: string | null;
}

function invariantError(m: MergedTask): string | null {
  const hasUntil =
    m.recurrence_until_utc != null || m.recurrence_until_date != null;
  if (m.recurrence_count != null && hasUntil) {
    return "recurrence COUNT and UNTIL are mutually exclusive";
  }
  if (m.recurrence_until_utc != null && m.recurrence_until_date != null) {
    return "recurrenceUntilUtc and recurrenceUntilDate are mutually exclusive";
  }
  if (m.all_day && m.due_at != null && m.due_date == null) {
    return "all-day tasks require dueDate (no UTC-midnight dueAt)";
  }
  if (m.rrule != null && m.dtstart_local == null) {
    return "recurring tasks require dtstartLocal";
  }
  return null;
}

function mergedFromPatch(row: TaskRow, patch: TaskPatch): MergedTask {
  return {
    recurrence_count:
      patch.recurrenceCount !== undefined ? patch.recurrenceCount : row.recurrence_count,
    recurrence_until_utc:
      patch.recurrenceUntilUtc !== undefined
        ? patch.recurrenceUntilUtc
        : row.recurrence_until_utc,
    recurrence_until_date:
      patch.recurrenceUntilDate !== undefined
        ? patch.recurrenceUntilDate
        : row.recurrence_until_date,
    all_day: patch.allDay !== undefined ? patch.allDay : isAllDay(row),
    due_date: patch.dueDate !== undefined ? patch.dueDate : row.due_date,
    due_at: patch.dueAt !== undefined ? patch.dueAt : row.due_at,
    rrule:
      patch.rrule !== undefined
        ? (patch.rrule === "" ? null : patch.rrule)
        : row.rrule,
    dtstart_local:
      patch.dtstartLocal !== undefined ? patch.dtstartLocal : row.dtstart_local,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const TASK_COLUMNS = `id, user_id, list_id, title, notes, ical_uid, caldav_href,
  status, priority, due_at, due_date, all_day, timezone, remind_at,
  reminder_time_local, remind_offset_minutes, snoozed_until, dtstart_local,
  next_occurrence_at, next_occurrence_local, occurrence_seq, rrule,
  recurrence_until_utc, recurrence_until_date, recurrence_count, wkst,
  recurrence_mode, clamp_policy, series_ended_at, missed_count, completed_at,
  sort_key, created_by, updated_by, rev, created_at, updated_at, deleted_at`;

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  // ---- POST /api/tasks --------------------------------------------------------
  app.post("/api/tasks", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
      return badRequest(req, reply, "Invalid task payload.");
    }
    const parsed = taskCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "Invalid task payload.", "invalid_task");
    }
    const data = parsed.data;
    if (data.listId !== undefined && data.listId !== null && !liveList(auth.user.id, data.listId)) {
      return badRequest(req, reply, "List not found.", "unknown_list");
    }
    if (data.timezone !== undefined && data.timezone !== null) {
      // zod already validated the IANA zone.
    }

    // Client-UUID replay first: same id, live row → identical result.
    if (data.id !== undefined) {
      const existing = getTask(auth.user.id, data.id);
      if (existing) {
        if (existing.deleted_at !== null) {
          return sendCurrentProblem(
            req,
            reply,
            409,
            "tombstoned",
            "That task ID was deleted; create with a new ID.",
            conflictCurrent(existing),
          );
        }
        return reply
          .code(200)
          .header("ETag", etagForRev(existing.rev))
          .header("idempotent-replayed", "true")
          .send(existing);
      }
    }

    const key = idempotencyKey(req);
    const opId = key ? `task:create:${auth.user.id}:${key}` : null;
    if (opId) {
      const prior = lookupOperation(opId);
      if (prior) {
        try {
          const parsedPrior = JSON.parse(prior.result_json) as { rev?: number };
          return reply
            .code(200)
            .header(
              "ETag",
              etagForRev(
                typeof parsedPrior.rev === "number" ? parsedPrior.rev : 1,
              ),
            )
            .header("idempotent-replayed", "true")
            .send(JSON.parse(prior.result_json));
        } catch {
          // fall through and recreate
        }
      }
    }

    const userTz = auth.user.timezone ?? "UTC";
    const now = nowIso();
    const id = data.id ?? newId();
    const allDay = data.allDay ?? false;
    // Derive armed reminders: dueAt/dueDate alone must enqueue. Explicit
    // remindAt (including null) always wins; otherwise due instant + offset.
    // Recurring series also compute the first occurrence when the client did
    // not supply one.
    const derived = deriveReminder({
      dueAt: data.dueAt ?? null,
      dueDate: data.dueDate ?? null,
      allDay,
      timezone: data.timezone ?? null,
      fallbackTimezone: userTz,
      reminderTimeLocal: data.reminderTimeLocal ?? null,
      remindOffsetMinutes: data.remindOffsetMinutes ?? null,
      explicitRemindAt:
        data.remindAt !== undefined ? data.remindAt : undefined,
      rrule: data.rrule ?? null,
      dtstartLocal: data.dtstartLocal ?? null,
      recurrenceCount: data.recurrenceCount ?? null,
      recurrenceUntilUtc: data.recurrenceUntilUtc ?? null,
      recurrenceUntilDate: data.recurrenceUntilDate ?? null,
      wkst: data.wkst ?? null,
      recurrenceMode: data.recurrenceMode ?? null,
      clampPolicy: data.clampPolicy ?? null,
    });
    const hasExplicitNextAt = data.nextOccurrenceAt !== undefined;
    const hasExplicitNextLocal = data.nextOccurrenceLocal !== undefined;
    const useDerivedSeries =
      (data.rrule ?? null) !== null &&
      !hasExplicitNextAt &&
      !hasExplicitNextLocal;
    const candidate: TaskRow = {
      id,
      user_id: auth.user.id,
      list_id: data.listId ?? null,
      title: data.title,
      notes: data.notes ?? null,
      // Persist the serializer fallbacks as real identities so the
      // per-collection unique indexes protect REST-created tasks too.
      ical_uid: `${id}@morrow`,
      caldav_href: `${id}.ics`,
      status: data.status ?? "open",
      priority: data.priority ?? 0,
      due_at: data.dueAt ?? null,
      due_date: data.dueDate ?? null,
      all_day: allDay ? 1 : 0,
      timezone: data.timezone ?? null,
      remind_at:
        data.remindAt !== undefined ? data.remindAt : derived.remindAt,
      reminder_time_local: data.reminderTimeLocal ?? null,
      remind_offset_minutes: data.remindOffsetMinutes ?? null,
      snoozed_until: data.snoozedUntil ?? null,
      dtstart_local: data.dtstartLocal ?? null,
      next_occurrence_at: useDerivedSeries
        ? derived.nextOccurrenceAt
        : (data.nextOccurrenceAt ?? null),
      next_occurrence_local: useDerivedSeries
        ? derived.nextOccurrenceLocal
        : (data.nextOccurrenceLocal ?? null),
      occurrence_seq: useDerivedSeries
        ? derived.occurrenceSeq
        : (data.occurrenceSeq ?? 0),
      rrule: data.rrule ?? null,
      recurrence_until_utc: data.recurrenceUntilUtc ?? null,
      recurrence_until_date: data.recurrenceUntilDate ?? null,
      recurrence_count: data.recurrenceCount ?? null,
      wkst: data.wkst ?? null,
      recurrence_mode: data.recurrenceMode ?? "schedule",
      clamp_policy: data.clampPolicy ?? "skip",
      series_ended_at: data.seriesEndedAt ?? null,
      missed_count: data.missedCount ?? 0,
      completed_at:
        data.completedAt ?? (data.status === "done" ? now : null),
      sort_key: data.sortKey ?? initialSortKey(),
      created_by: "user",
      updated_by: "user",
      rev: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    if (candidate.rrule) {
      const problem = checkRecurrence(candidate, userTz);
      if (problem) return badRequest(req, reply, problem, "invalid_recurrence");
    }

    const batchId = newId();
    const tx = getDb().transaction(() => {
      getDb()
        .prepare(
          `INSERT INTO tasks (${TASK_COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          candidate.id, candidate.user_id, candidate.list_id, candidate.title,
          candidate.notes, candidate.ical_uid, candidate.caldav_href,
          candidate.status, candidate.priority, candidate.due_at,
          candidate.due_date, candidate.all_day, candidate.timezone,
          candidate.remind_at, candidate.reminder_time_local,
          candidate.remind_offset_minutes, candidate.snoozed_until,
          candidate.dtstart_local, candidate.next_occurrence_at,
          candidate.next_occurrence_local, candidate.occurrence_seq,
          candidate.rrule, candidate.recurrence_until_utc,
          candidate.recurrence_until_date, candidate.recurrence_count,
          candidate.wkst, candidate.recurrence_mode, candidate.clamp_policy,
          candidate.series_ended_at, candidate.missed_count,
          candidate.completed_at, candidate.sort_key, candidate.created_by,
          candidate.updated_by, candidate.rev, candidate.created_at,
          candidate.updated_at, candidate.deleted_at,
        );
      writeActivityTx({
        batchId,
        opId: key,
        actorId: auth.user.id,
        action: "task.create",
        entityType: "task",
        entityId: id,
        before: null,
        after: candidate,
        summary: `created task "${candidate.title}"`,
      });
      const storeIds = new Set<string>();
      if (opId) storeIds.add(opId);
      if (data.id) storeIds.add(`task:create:${auth.user.id}:${data.id}`);
      for (const storeId of storeIds) {
        storeOperationTx({
          opId: storeId,
          kind: "task-create",
          entityId: id,
          baseRev: null,
          payloadHash: sha256Json({ title: candidate.title, list: candidate.list_id }),
          result: candidate,
        });
      }
    });
    try {
      tx();
    } catch (err) {
      if (
        err instanceof Error &&
        /UNIQUE constraint failed/.test(err.message)
      ) {
        return sendProblem(req, reply, 409, "Conflict", {
          detail:
            "A task with the same CalDAV identity already exists in this collection.",
          code: "collection_identity_conflict",
        });
      }
      throw err;
    }
    publishAfterCommit({ type: "task.create", entityKind: "task", entityId: id, rev: 1 });
    return reply.code(201).header("ETag", etagForRev(1)).send(candidate);
  });

  // ---- GET /api/tasks (views + cursor pagination) -------------------------------
  app.get("/api/tasks", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const view = (q["view"] ?? "all").toLowerCase();
    if (view !== "all" && view !== "today" && view !== "upcoming" && view !== "inbox") {
      return badRequest(req, reply, "view must be today|upcoming|inbox|all.");
    }
    const statusFilter = q["status"];
    if (
      statusFilter !== undefined &&
      statusFilter !== "open" &&
      statusFilter !== "done" &&
      statusFilter !== "cancelled"
    ) {
      return badRequest(req, reply, "status must be open|done|cancelled.");
    }
    let limit = Number.parseInt(q["limit"] ?? "50", 10);
    if (!Number.isSafeInteger(limit)) limit = 50;
    limit = Math.min(200, Math.max(1, limit));
    let offset = 0;
    if (q["cursor"] !== undefined && q["cursor"] !== "") {
      offset = Number.parseInt(q["cursor"] as string, 10);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        return badRequest(req, reply, "Invalid cursor.", "invalid_cursor");
      }
    }

    // Push list/status/view filters, ordering, and the page window into SQL.
    // The custom helpers above reuse the exact day-key/sort rules, so this is
    // still the same ordering the PWA sees while only limit+1 rows cross into
    // JS (the extra row is the has-more sentinel).
    ensureTaskQueryFunctions(getDb());
    const params: unknown[] = [auth.user.id, auth.user.id, auth.user.id];
    let where = `(${TASK_ACCESS_SQL}) AND t.deleted_at IS NULL`;
    if (q["listId"] !== undefined && q["listId"] !== "") {
      where += " AND list_id = ?";
      params.push(q["listId"]);
    }
    if (statusFilter !== undefined) {
      where += " AND status = ?";
      params.push(statusFilter);
    }
    if (q["tagId"] !== undefined && q["tagId"] !== "") {
      where +=
        " AND id IN (SELECT task_id FROM task_tags WHERE tag_id = ?)";
      params.push(q["tagId"]);
    }

    const tz = auth.user.timezone ?? "UTC";
    const dayKeySql = `${TASK_DAY_KEY_FN}(all_day, rrule, next_occurrence_local, due_date, next_occurrence_at, due_at, ?)`;
    if (view !== "all") {
      where += " AND status = 'open'";
      if (view === "inbox") {
        where += ` AND ${dayKeySql} IS NULL`;
        params.push(tz);
      } else {
        const today = todayKeyInTz(tz);
        where +=
          view === "today"
            ? ` AND ${dayKeySql} <= ?`
            : ` AND ${dayKeySql} > ?`;
        params.push(tz, today);
      }
    }
    const sortMsSql = `${TASK_SORT_MS_FN}(all_day, rrule, next_occurrence_local, due_date, next_occurrence_at, due_at)`;
    const rows = getDb()
      .prepare(
        `SELECT t.* FROM tasks t
          WHERE ${where}
          ORDER BY (${sortMsSql} IS NULL) ASC,
                   ${sortMsSql} ASC,
                   title COLLATE NOCASE ASC, id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit + 1, offset) as TaskRow[];
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? String(offset + limit) : null;
    return reply.send(taskPageBody(page, next));
  });

  // ---- GET /api/tasks/:id ---------------------------------------------------------
  app.get("/api/tasks/:id", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const row = getTask(auth.user.id, id);
    if (!row) return notFound(req, reply);
    if (row.deleted_at !== null) return gone(req, reply, "Task");
    return reply.header("ETag", etagForRev(row.rev)).send(row);
  });

  // ---- PATCH /api/tasks/:id ---------------------------------------------------------
  app.patch("/api/tasks/:id", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const existing = getTask(auth.user.id, id);
    if (!existing) return notFound(req, reply);
    if (existing.deleted_at !== null) return gone(req, reply, "Task");

    if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
      return badRequest(req, reply, "Invalid task patch.");
    }
    const parsed = taskPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return badRequest(req, reply, "Invalid task patch.", "invalid_task");
    }
    const patch = parsed.data;
    if (patch.listId !== undefined && patch.listId !== null && !liveList(auth.user.id, patch.listId)) {
      return badRequest(req, reply, "List not found.", "unknown_list");
    }

    // Idempotent retry first (hash-gated): same key + same payload replays.
    const key = idempotencyKey(req);
    const opId = key ? `task:patch:${auth.user.id}:${id}:${key}` : null;
    const payloadHash = key ? sha256Json(patch) : null;
    if (opId && payloadHash) {
      const prior = lookupOperation(opId);
      if (prior && prior.payload_hash === payloadHash) {
        try {
          const body = JSON.parse(prior.result_json) as { rev?: number };
          return reply
            .code(200)
            .header("ETag", etagForRev(typeof body.rev === "number" ? body.rev : existing.rev))
            .header("idempotent-replayed", "true")
            .send(JSON.parse(prior.result_json));
        } catch {
          // fall through
        }
      }
    }

    if (!checkIfMatch(req, reply, conflictCurrent(existing))) return reply;

    const merged = mergedFromPatch(existing, patch);
    // Empty-string rrule clears the rule.
    if (patch.rrule === "") merged.rrule = null;
    const invariant = invariantError(merged);
    if (invariant) return badRequest(req, reply, invariant, "invalid_task");

    const userTz = auth.user.timezone ?? "UTC";
    const probe: TaskRow = {
      ...existing,
      rrule: merged.rrule,
      dtstart_local: merged.dtstart_local,
      timezone: patch.timezone !== undefined ? patch.timezone : existing.timezone,
      recurrence_count: merged.recurrence_count,
      recurrence_until_utc: merged.recurrence_until_utc,
      recurrence_until_date: merged.recurrence_until_date,
      wkst: patch.wkst !== undefined ? patch.wkst : existing.wkst,
      clamp_policy: patch.clampPolicy ?? existing.clamp_policy,
      all_day: merged.all_day ? 1 : 0,
    };
    if (probe.rrule) {
      const problem = checkRecurrence(probe, userTz);
      if (problem) return badRequest(req, reply, problem, "invalid_recurrence");
    }

    // Recompute armed reminders when the schedule changes. Explicit remindAt
    // (including null) wins; otherwise due instant + offset. Timezone changes
    // re-resolve future occurrences; past completion keys stay untouched.
    // Rescheduling cancels stale pending deliveries (fresh reminder enqueues
    // next tick).
    const scheduleTouched =
      patch.dueAt !== undefined ||
      patch.dueDate !== undefined ||
      patch.allDay !== undefined ||
      patch.timezone !== undefined ||
      patch.reminderTimeLocal !== undefined ||
      patch.remindOffsetMinutes !== undefined ||
      patch.rrule !== undefined ||
      patch.dtstartLocal !== undefined ||
      patch.recurrenceUntilUtc !== undefined ||
      patch.recurrenceUntilDate !== undefined ||
      patch.recurrenceCount !== undefined ||
      patch.wkst !== undefined ||
      patch.recurrenceMode !== undefined ||
      patch.clampPolicy !== undefined ||
      patch.remindAt !== undefined ||
      patch.nextOccurrenceAt !== undefined ||
      patch.nextOccurrenceLocal !== undefined;
    let finalRemindAt: string | null =
      patch.remindAt !== undefined ? patch.remindAt : existing.remind_at;
    let finalNextAt: string | null =
      patch.nextOccurrenceAt !== undefined
        ? patch.nextOccurrenceAt
        : existing.next_occurrence_at;
    let finalNextLocal: string | null =
      patch.nextOccurrenceLocal !== undefined
        ? patch.nextOccurrenceLocal
        : existing.next_occurrence_local;
    let finalSeq: number =
      patch.occurrenceSeq ?? existing.occurrence_seq;
    let rescheduled = false;
    if (scheduleTouched) {
      const derivedPatch = deriveReminder({
        dueAt: merged.due_at,
        dueDate: merged.due_date,
        allDay: merged.all_day,
        timezone:
          patch.timezone !== undefined ? patch.timezone : existing.timezone,
        fallbackTimezone: userTz,
        reminderTimeLocal:
          patch.reminderTimeLocal !== undefined
            ? patch.reminderTimeLocal
            : existing.reminder_time_local,
        remindOffsetMinutes:
          patch.remindOffsetMinutes !== undefined
            ? patch.remindOffsetMinutes
            : existing.remind_offset_minutes,
        explicitRemindAt:
          patch.remindAt !== undefined ? patch.remindAt : undefined,
        rrule: merged.rrule,
        dtstartLocal: merged.dtstart_local,
        recurrenceCount: merged.recurrence_count,
        recurrenceUntilUtc: merged.recurrence_until_utc,
        recurrenceUntilDate: merged.recurrence_until_date,
        wkst: patch.wkst !== undefined ? patch.wkst : existing.wkst,
        recurrenceMode: patch.recurrenceMode ?? existing.recurrence_mode,
        clampPolicy: patch.clampPolicy ?? existing.clamp_policy,
      });
      if (patch.remindAt === undefined) {
        finalRemindAt = derivedPatch.remindAt;
      }
      const hasExplicitNext =
        patch.nextOccurrenceAt !== undefined ||
        patch.nextOccurrenceLocal !== undefined;
      // Only a schedule-defining change may re-anchor a live series. A
      // timezone/reminder-only edit must preserve the current occurrence;
      // deriveReminder intentionally returns the first DTSTART occurrence and
      // would otherwise rewind the series.
      const seriesAnchorChanged =
        patch.dueAt !== undefined ||
        patch.dueDate !== undefined ||
        patch.allDay !== undefined ||
        patch.rrule !== undefined ||
        patch.dtstartLocal !== undefined ||
        patch.recurrenceUntilUtc !== undefined ||
        patch.recurrenceUntilDate !== undefined ||
        patch.recurrenceCount !== undefined ||
        patch.wkst !== undefined ||
        patch.recurrenceMode !== undefined ||
        patch.clampPolicy !== undefined;
      if (!hasExplicitNext && merged.rrule && !seriesAnchorChanged) {
        finalNextAt = existing.next_occurrence_at;
        finalNextLocal = existing.next_occurrence_local;
        finalSeq = existing.occurrence_seq;
        if (patch.remindAt === undefined) {
          const mergedReminderTime =
            patch.reminderTimeLocal !== undefined
              ? patch.reminderTimeLocal
              : existing.reminder_time_local;
          const mergedOffset =
            patch.remindOffsetMinutes !== undefined
              ? patch.remindOffsetMinutes
              : existing.remind_offset_minutes;
          if (merged.all_day && existing.next_occurrence_local) {
            const date = existing.next_occurrence_local.slice(0, 10);
            const time = mergedReminderTime ?? "09:00:00";
            try {
              const resolved = resolveWallTime(
                `${date}T${time}`,
                patch.timezone !== undefined
                  ? (patch.timezone ?? userTz)
                  : (existing.timezone ?? userTz),
              );
              finalRemindAt = applyReminderOffset(resolved.instantIso, mergedOffset);
            } catch {
              finalRemindAt = existing.remind_at;
            }
          } else if (existing.next_occurrence_at) {
            finalRemindAt = applyReminderOffset(
              existing.next_occurrence_at,
              mergedOffset,
            );
          }
        }
      } else if (!hasExplicitNext && merged.rrule) {
        finalNextAt = derivedPatch.nextOccurrenceAt;
        finalNextLocal = derivedPatch.nextOccurrenceLocal;
        finalSeq = derivedPatch.occurrenceSeq;
      } else if (!hasExplicitNext && !merged.rrule) {
        // One-off reschedule without a rule: clear stale recurrence state.
        // The derived remind_at above already reflects the new due instant.
        finalNextAt = null;
        finalNextLocal = null;
      }
      const beforeKey = `${existing.due_at}|${existing.due_date}|${existing.all_day}|${existing.timezone}|${existing.reminder_time_local}|${existing.remind_offset_minutes}|${existing.rrule}|${existing.dtstart_local}|${existing.next_occurrence_at}`;
      const afterKey = `${merged.due_at}|${merged.due_date}|${merged.all_day ? 1 : 0}|${patch.timezone !== undefined ? patch.timezone : existing.timezone}|${patch.reminderTimeLocal !== undefined ? patch.reminderTimeLocal : existing.reminder_time_local}|${patch.remindOffsetMinutes !== undefined ? patch.remindOffsetMinutes : existing.remind_offset_minutes}|${merged.rrule}|${merged.dtstart_local}|${finalNextAt}`;
      rescheduled =
        beforeKey !== afterKey ||
        finalRemindAt !== existing.remind_at;
    }

    const now = nowIso();
    const nextStatus = patch.status ?? existing.status;
    const statusChanged = nextStatus !== existing.status;
    const listChanged =
      patch.listId !== undefined &&
      (patch.listId ?? null) !== existing.list_id;
    if (listChanged) {
      // A shared-list editor must not be able to re-home someone else's task
      // into a list that exposes it to different accounts. Moving a task is a
      // creator action, matching the CalDAV MOVE rule.
      if (existing.user_id !== auth.user.id) {
        return sendProblem(req, reply, 403, "Forbidden", {
          detail: "Only the task creator can move a shared-list task.",
          code: "creator_only",
        });
      }
      const conflict = targetIdentityConflict(existing, patch.listId ?? null);
      if (conflict) {
        return sendProblem(req, reply, 409, "Conflict", {
          detail: `Cannot move the task: its ${conflict.field} is already used in the target collection (${conflict.existingHref}).`,
          code: "collection_identity_conflict",
        });
      }
    }
    let completedAt = existing.completed_at;
    if (statusChanged) {
      if (nextStatus === "done") {
        completedAt = patch.completedAt ?? now;
      } else {
        completedAt = null;
      }
    } else if (patch.completedAt !== undefined) {
      completedAt = patch.completedAt;
    }

    const batchId = newId();
    const tx = getDb().transaction(() => {
      getDb()
        .prepare(
          `UPDATE tasks SET
             title = ?, notes = ?, status = ?, priority = ?, list_id = ?,
             due_at = ?, due_date = ?, all_day = ?, timezone = ?,
             remind_at = ?, reminder_time_local = ?, remind_offset_minutes = ?,
             snoozed_until = ?, dtstart_local = ?,
             next_occurrence_at = ?, next_occurrence_local = ?,
             occurrence_seq = ?, rrule = ?, recurrence_until_utc = ?,
             recurrence_until_date = ?, recurrence_count = ?, wkst = ?,
             recurrence_mode = ?, clamp_policy = ?, series_ended_at = ?,
             missed_count = ?, completed_at = ?, sort_key = ?,
             updated_by = 'user', rev = rev + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          patch.title ?? existing.title,
          patch.notes !== undefined ? patch.notes : existing.notes,
          nextStatus,
          patch.priority ?? existing.priority,
          patch.listId !== undefined ? patch.listId : existing.list_id,
          patch.dueAt !== undefined ? patch.dueAt : existing.due_at,
          patch.dueDate !== undefined ? patch.dueDate : existing.due_date,
          merged.all_day ? 1 : 0,
          patch.timezone !== undefined ? patch.timezone : existing.timezone,
          finalRemindAt,
          patch.reminderTimeLocal !== undefined
            ? patch.reminderTimeLocal
            : existing.reminder_time_local,
          patch.remindOffsetMinutes !== undefined
            ? patch.remindOffsetMinutes
            : existing.remind_offset_minutes,
          patch.snoozedUntil !== undefined ? patch.snoozedUntil : existing.snoozed_until,
          merged.dtstart_local,
          finalNextAt,
          finalNextLocal,
          patch.occurrenceSeq ?? finalSeq,
          merged.rrule,
          merged.recurrence_until_utc,
          merged.recurrence_until_date,
          merged.recurrence_count,
          patch.wkst !== undefined ? patch.wkst : existing.wkst,
          patch.recurrenceMode ?? existing.recurrence_mode,
          patch.clampPolicy ?? existing.clamp_policy,
          patch.seriesEndedAt !== undefined
            ? patch.seriesEndedAt
            : existing.series_ended_at,
          patch.missedCount ?? existing.missed_count,
          completedAt,
          patch.sortKey ?? existing.sort_key,
          now,
          id,
        );
      // A list move can revoke access for old members (shared -> private or
      // private -> a different share). Drop their queued reminders before the
      // next tick; current members' rows are preserved.
      if (listChanged) {
        cancelPendingDeliveriesForTask(getDb(), id, new Date(now));
      }
      // PATCH straight to done/cancelled keeps the ledger honest.
      let cancelled = 0;
      if (rescheduled) {
        // Never leave a stale reminder at the old time; the fresh instant
        // enqueues on the next scheduler tick.
        cancelled += cancelPendingDeliveriesTx(id);
      }
      if (statusChanged && (nextStatus === "done" || nextStatus === "cancelled")) {
        const occKey = defaultOccurrenceKey(existing, userTz);
        try {
          getDb()
            .prepare(
              `INSERT INTO task_completions
                 (id, task_id, occurrence_key, status, completed_at, source, rev, created_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, 'user', 1, ?, NULL)`,
            )
            .run(newId(), id, occKey, nextStatus === "done" ? "completed" : "skipped", now, now);
        } catch {
          // Completion row already present (unique key): ledger is intact.
        }
        cancelled += cancelPendingDeliveriesTx(id);
      }
      const after = getTask(auth.user.id, id) as TaskRow;
      writeActivityTx({
        batchId,
        opId: key,
        actorId: auth.user.id,
        action: "task.update",
        entityType: "task",
        entityId: id,
        before: existing,
        after,
        summary:
          `updated task "${after.title}"` +
          (cancelled > 0 ? ` (cancelled ${cancelled} pending deliveries)` : ""),
      });
      if (opId && payloadHash) {
        storeOperationTx({
          opId,
          kind: "task-patch",
          entityId: id,
          baseRev: existing.rev,
          payloadHash,
          result: after,
        });
      }
    });
    tx();
    const after = getTask(auth.user.id, id) as TaskRow;
    publishAfterCommit({ type: "task.update", entityKind: "task", entityId: id, rev: after.rev });
    return reply.header("ETag", etagForRev(after.rev)).send(after);
  });

  // ---- DELETE /api/tasks/:id ----------------------------------------------------------
  app.delete("/api/tasks/:id", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const existing = getTask(auth.user.id, id);
    if (!existing) return notFound(req, reply);
    if (existing.deleted_at !== null) return gone(req, reply, "Task");
    if (!checkIfMatch(req, reply, conflictCurrent(existing))) return reply;

    const now = nowIso();
    const batchId = newId();
    const tx = getDb().transaction(() => {
      getDb()
        .prepare(
          `UPDATE tasks
              SET deleted_at = ?, updated_by = 'user', rev = rev + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(now, now, id);
      const cancelled = cancelPendingDeliveriesTx(id);
      const after = getTask(auth.user.id, id) as TaskRow;
      writeActivityTx({
        batchId,
        opId: null,
        actorId: auth.user.id,
        action: "task.delete",
        entityType: "task",
        entityId: id,
        before: existing,
        after,
        summary:
          `deleted task "${existing.title}"` +
          (cancelled > 0 ? ` (cancelled ${cancelled} pending deliveries)` : ""),
      });
    });
    tx();
    const after = getTask(auth.user.id, id) as TaskRow;
    publishAfterCommit({ type: "task.delete", entityKind: "task", entityId: id, rev: after.rev });
    return reply
      .header("ETag", etagForRev(after.rev))
      .send({ ok: true, id, rev: after.rev });
  });

  // ---- POST /api/tasks/:id/complete -------------------------------------------------------
  app.post("/api/tasks/:id/complete", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const existing = getTask(auth.user.id, id);
    if (!existing) return notFound(req, reply);
    if (existing.deleted_at !== null) return gone(req, reply, "Task");

    const body = req.body ?? {};
    if (body !== null && typeof body !== "object") {
      return badRequest(req, reply, "Invalid complete payload.");
    }
    // Validate the small complete payload manually to keep the 400 surface tiny.
    const rawOcc =
      (body as Record<string, unknown>)["occurrenceKey"] ?? undefined;
    const rawAt = (body as Record<string, unknown>)["completedAt"] ?? undefined;
    const rawSource = (body as Record<string, unknown>)["source"] ?? undefined;
    if (rawOcc !== undefined && (typeof rawOcc !== "string" || !isOccurrenceKey(rawOcc))) {
      return badRequest(req, reply, "Invalid occurrenceKey.", "invalid_task");
    }
    if (rawAt !== undefined && !isUtcIso(rawAt as string)) {
      return badRequest(req, reply, "Invalid completedAt.", "invalid_task");
    }
    if (
      rawSource !== undefined &&
      rawSource !== "user" &&
      rawSource !== "scheduler" &&
      rawSource !== "import"
    ) {
      return badRequest(req, reply, "Invalid source.", "invalid_task");
    }

    const userTz = auth.user.timezone ?? "UTC";
    const occurrenceKey =
      typeof rawOcc === "string" ? rawOcc : defaultOccurrenceKey(existing, userTz);
    const completedAtIso =
      typeof rawAt === "string" && isUtcIso(rawAt) ? rawAt : nowIso();
    const source = typeof rawSource === "string" ? rawSource : "user";

    // Natural idempotency: the same occurrence completes exactly once.
    const priorCompletion = getCompletion(id, occurrenceKey);
    if (priorCompletion) {
      return reply
        .code(200)
        .header("ETag", etagForRev(existing.rev))
        .header("idempotent-replayed", "true")
        .send(existing);
    }
    const key = idempotencyKey(req);
    const opId = key ? `task:complete:${auth.user.id}:${id}:${key}` : null;
    const payloadHash = key ? sha256Json({ occurrenceKey, completedAtIso, source }) : null;
    if (opId && payloadHash) {
      const prior = lookupOperation(opId);
      if (prior && prior.payload_hash === payloadHash) {
        try {
          const bodyJson = JSON.parse(prior.result_json) as { rev?: number };
          return reply
            .code(200)
            .header("ETag", etagForRev(typeof bodyJson.rev === "number" ? bodyJson.rev : existing.rev))
            .header("idempotent-replayed", "true")
            .send(JSON.parse(prior.result_json));
        } catch {
          // fall through
        }
      }
    }

    if (!checkIfMatch(req, reply, conflictCurrent(existing))) return reply;

    const now = nowIso();
    const batchId = newId();
    const advanced = advanceSeries(existing, userTz, occurrenceKey, completedAtIso);
    const completionId = newId();
    const completionRow = {
      id: completionId,
      task_id: id,
      occurrence_key: occurrenceKey,
      status: "completed",
      completed_at: completedAtIso,
      source,
      rev: 1,
      created_at: now,
      deleted_at: null,
    };
    const tx = getDb().transaction(() => {
      getDb()
        .prepare(
          `INSERT INTO task_completions
             (id, task_id, occurrence_key, status, completed_at, source, rev, created_at, deleted_at)
           VALUES (?, ?, ?, 'completed', ?, ?, 1, ?, NULL)`,
        )
        .run(completionId, id, occurrenceKey, completedAtIso, source, now);
      if (advanced && !advanced.ended) {
        getDb()
          .prepare(
            `UPDATE tasks SET
               next_occurrence_at = ?, next_occurrence_local = ?,
               occurrence_seq = ?, completed_at = ?,
               snoozed_until = NULL,
               updated_by = 'user', rev = rev + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            advanced.nextAt, advanced.nextLocal, advanced.seq,
            completedAtIso, now, id,
          );
      } else {
        getDb()
          .prepare(
            `UPDATE tasks SET
               status = 'done', completed_at = ?,
               ${advanced?.ended ? "series_ended_at = ?," : ""}
               next_occurrence_at = NULL, next_occurrence_local = NULL,
               snoozed_until = NULL,
               updated_by = 'user', rev = rev + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            ...(advanced?.ended ? [completedAtIso, now] : [completedAtIso]),
            now,
            id,
          );
      }
      const cancelled = cancelPendingDeliveriesTx(id);
      const after = getTask(auth.user.id, id) as TaskRow;
      writeActivityTx({
        batchId,
        opId: key,
        actorId: auth.user.id,
        action: "task.complete",
        entityType: "task",
        entityId: id,
        before: existing,
        after: { ...after, completion: completionRow },
        summary:
          `completed "${existing.title}" @ ${occurrenceKey}` +
          (cancelled > 0 ? ` (cancelled ${cancelled} pending deliveries)` : ""),
      });
      if (opId && payloadHash) {
        storeOperationTx({
          opId,
          kind: "task-complete",
          entityId: id,
          baseRev: existing.rev,
          payloadHash,
          result: after,
        });
      }
    });
    tx();
    const after = getTask(auth.user.id, id) as TaskRow;
    publishAfterCommit({
      type: "task.complete",
      entityKind: "task",
      entityId: id,
      rev: after.rev,
    });
    return reply.header("ETag", etagForRev(after.rev)).send(after);
  });

  // ---- POST /api/tasks/:id/snooze ----------------------------------------------------------
  app.post("/api/tasks/:id/snooze", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const existing = getTask(auth.user.id, id);
    if (!existing) return notFound(req, reply);
    if (existing.deleted_at !== null) return gone(req, reply, "Task");

    const body =
      req.body !== null && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : null;
    const until = body?.["until"];
    if (typeof until !== "string" || !isUtcIso(until)) {
      return badRequest(req, reply, "snooze requires until (UTC ISO).", "invalid_task");
    }
    if (Date.parse(until) <= Date.now()) {
      return badRequest(req, reply, "snooze until must be in the future.", "invalid_until");
    }

    const key = idempotencyKey(req);
    const opId = key ? `task:snooze:${auth.user.id}:${id}:${key}` : null;
    const payloadHash = key ? sha256Json({ until }) : null;
    if (opId && payloadHash) {
      const prior = lookupOperation(opId);
      if (prior && prior.payload_hash === payloadHash) {
        try {
          const bodyJson = JSON.parse(prior.result_json) as { rev?: number };
          return reply
            .code(200)
            .header("ETag", etagForRev(typeof bodyJson.rev === "number" ? bodyJson.rev : existing.rev))
            .header("idempotent-replayed", "true")
            .send(JSON.parse(prior.result_json));
        } catch {
          // fall through
        }
      }
    }

    if (!checkIfMatch(req, reply, conflictCurrent(existing))) return reply;

    const now = nowIso();
    const batchId = newId();
    const tx = getDb().transaction(() => {
      getDb()
        .prepare(
          `UPDATE tasks SET
             snoozed_until = ?, updated_by = 'user', rev = rev + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(until, now, id);
      const cancelled = cancelPendingDeliveriesTx(id);
      const after = getTask(auth.user.id, id) as TaskRow;
      writeActivityTx({
        batchId,
        opId: key,
        actorId: auth.user.id,
        action: "task.snooze",
        entityType: "task",
        entityId: id,
        before: existing,
        after,
        summary:
          `snoozed "${existing.title}" until ${until}` +
          (cancelled > 0 ? ` (cancelled ${cancelled} pending deliveries)` : ""),
      });
      if (opId && payloadHash) {
        storeOperationTx({
          opId,
          kind: "task-snooze",
          entityId: id,
          baseRev: existing.rev,
          payloadHash,
          result: after,
        });
      }
    });
    tx();
    const after = getTask(auth.user.id, id) as TaskRow;
    publishAfterCommit({ type: "task.snooze", entityKind: "task", entityId: id, rev: after.rev });
    return reply.header("ETag", etagForRev(after.rev)).send(after);
  });

  // ---- POST /api/tasks/:id/skip ---------------------------------------------------------------
  app.post("/api/tasks/:id/skip", async (req, reply) => {
    const auth = authed(req, reply);
    if (!auth) return reply;
    const id = (req.params as { id?: string }).id ?? "";
    const existing = getTask(auth.user.id, id);
    if (!existing) return notFound(req, reply);
    if (existing.deleted_at !== null) return gone(req, reply, "Task");

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== "object") {
      return badRequest(req, reply, "Invalid skip payload.");
    }
    const rawOcc = body["occurrenceKey"] ?? undefined;
    if (rawOcc !== undefined && (typeof rawOcc !== "string" || !isOccurrenceKey(rawOcc))) {
      return badRequest(req, reply, "Invalid occurrenceKey.", "invalid_task");
    }
    const userTz = auth.user.timezone ?? "UTC";
    const occurrenceKey =
      typeof rawOcc === "string" ? rawOcc : defaultOccurrenceKey(existing, userTz);

    const priorCompletion = getCompletion(id, occurrenceKey);
    if (priorCompletion) {
      return reply
        .code(200)
        .header("ETag", etagForRev(existing.rev))
        .header("idempotent-replayed", "true")
        .send(existing);
    }
    const key = idempotencyKey(req);
    const opId = key ? `task:skip:${auth.user.id}:${id}:${key}` : null;
    const payloadHash = key ? sha256Json({ occurrenceKey }) : null;
    if (opId && payloadHash) {
      const prior = lookupOperation(opId);
      if (prior && prior.payload_hash === payloadHash) {
        try {
          const bodyJson = JSON.parse(prior.result_json) as { rev?: number };
          return reply
            .code(200)
            .header("ETag", etagForRev(typeof bodyJson.rev === "number" ? bodyJson.rev : existing.rev))
            .header("idempotent-replayed", "true")
            .send(JSON.parse(prior.result_json));
        } catch {
          // fall through
        }
      }
    }

    if (!checkIfMatch(req, reply, conflictCurrent(existing))) return reply;

    const now = nowIso();
    const batchId = newId();
    const advanced = advanceSeries(existing, userTz, occurrenceKey, now);
    const completionId = newId();
    const completionRow = {
      id: completionId,
      task_id: id,
      occurrence_key: occurrenceKey,
      status: "skipped",
      completed_at: now,
      source: "user",
      rev: 1,
      created_at: now,
      deleted_at: null,
    };
    const tx = getDb().transaction(() => {
      getDb()
        .prepare(
          `INSERT INTO task_completions
             (id, task_id, occurrence_key, status, completed_at, source, rev, created_at, deleted_at)
           VALUES (?, ?, ?, 'skipped', ?, 'user', 1, ?, NULL)`,
        )
        .run(completionId, id, occurrenceKey, now, now);
      if (advanced && !advanced.ended) {
        getDb()
          .prepare(
            `UPDATE tasks SET
               next_occurrence_at = ?, next_occurrence_local = ?,
               occurrence_seq = ?, snoozed_until = NULL,
               updated_by = 'user', rev = rev + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(advanced.nextAt, advanced.nextLocal, advanced.seq, now, id);
      } else if (advanced?.ended) {
        getDb()
          .prepare(
            `UPDATE tasks SET
               status = 'done', completed_at = ?, series_ended_at = ?,
               next_occurrence_at = NULL, next_occurrence_local = NULL,
               snoozed_until = NULL,
               updated_by = 'user', rev = rev + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(now, now, now, id);
      } else {
        // One-shot skip: the task is not coming back, but it was not done.
        getDb()
          .prepare(
            `UPDATE tasks SET
               status = 'cancelled', snoozed_until = NULL,
               updated_by = 'user', rev = rev + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(now, id);
      }
      const cancelled = cancelPendingDeliveriesTx(id);
      const after = getTask(auth.user.id, id) as TaskRow;
      writeActivityTx({
        batchId,
        opId: key,
        actorId: auth.user.id,
        action: "task.skip",
        entityType: "task",
        entityId: id,
        before: existing,
        after: { ...after, completion: completionRow },
        summary:
          `skipped "${existing.title}" @ ${occurrenceKey}` +
          (cancelled > 0 ? ` (cancelled ${cancelled} pending deliveries)` : ""),
      });
      if (opId && payloadHash) {
        storeOperationTx({
          opId,
          kind: "task-skip",
          entityId: id,
          baseRev: existing.rev,
          payloadHash,
          result: after,
        });
      }
    });
    tx();
    const after = getTask(auth.user.id, id) as TaskRow;
    publishAfterCommit({ type: "task.skip", entityKind: "task", entityId: id, rev: after.rev });
    return reply.header("ETag", etagForRev(after.rev)).send(after);
  });
}
