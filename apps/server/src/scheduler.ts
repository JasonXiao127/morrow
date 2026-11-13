/**
 * Reminder scheduler (§4).
 *
 * ## Tick
 * One 15s interval per process. A process takes `scheduler_state`'s lease
 * (`lease_owner`/`lease_until`) before doing work; a second container skips
 * until the lease expires. Work is split into three phases:
 *
 *   1. ENQUEUE   one `BEGIN IMMEDIATE` transaction
 *   2. CLAIM     one `BEGIN IMMEDIATE` transaction
 *   3. SEND      outside both transactions (network never holds SQLite)
 *
 * ## Enqueue
 * - Schedule mode: every boundary that passed while the server was down is
 *   written as a `task_completions` row with status `missed`, then
 *   `next_occurrence_*` advances using the shared recurrence engine.
 * - Completion mode: the scheduler never advances `next_occurrence_*` and
 *   never writes `missed` rows. The occurrence stays due until the user
 *   completes or skips it; the delivery unique key prevents repeat pushes.
 * - Deliveries use `INSERT OR IGNORE` on
 *   `(task_id, occurrence_key, kind, channel, subscription_id)`, so a retry of
 *   the same tick (crash, duplicate process, repeated catch-up) is a no-op.
 *
 * ## Catch-up / digest
 * A single tick with `>= 2` due boundaries, or one boundary more than 30
 * minutes late, is a downtime event: the missed rows are recorded and ONE
 * `digest` delivery is enqueued instead of N reminder pushes. Catch-up is
 * capped at `catchupLimit` occurrences per task per tick; the remaining
 * boundaries are folded into the next digest rather than growing unbounded.
 *
 * ## Quiet hours
 * `settings.quietHours` = `{enabled, start, end}` in the user's timezone.
 * Non-urgent reminders (priority < 3) are held until the next local `end`
 * instant, resolved through Temporal so a DST gap/fold does not shift the
 * window. Urgent reminders (priority >= 3) bypass quiet hours. The tick
 * re-checks quiet hours after claiming a delivery because settings can change
 * after it was queued.
 *
 * ## Duplicate policy (at-least-once)
 * Web Push has no server-side idempotency. A crash after the push service
 * accepts a request but before `sent` commits can produce a duplicate. Every
 * payload therefore carries a deterministic `deliveryId`; the service worker
 * keeps a bounded dedupe cache and uses `Topic` to coalesce bursts. We promise
 * "delivered or visibly failed", never "exactly once". `markSent()` only
 * succeeds with `WHERE id=? AND claim_token=? AND status='sending'`, so a
 * reclaimed/stale worker can never overwrite a newer claim.
 */
import type { BetterDb } from "@morrow/db";
import { getDb } from "@morrow/db";
import {
  addWallDays,
  applyReminderOffset,
  DEFAULT_ALL_DAY_REMINDER_TIME,
  generateOccurrences,
  isUtcIso,
  isValidTimeZone,
  isWallDate,
  newId,
  nextOccurrenceAfter,
  normalizeWallTime,
  resolveAllDayReminder,
  resolveWallTime,
  toUtcIso,
  wallDateTimeInZone,
  type Occurrence,
  type RecurrenceInput,
} from "@morrow/shared";
import { publishActivity, type ActivityEventRow } from "./sse.js";
import { runRetention } from "./retention.js";
import { maybeSendDigests } from "./digests.js";
import { readNtfyConfig } from "./ntfy.js";
import { TASK_ACCESS_SQL } from "./access.js";
import { deliveryRecipientLostAccess } from "./deliveries.js";
import { isMaintenanceActive } from "./maintenance.js";
import { pruneChanges } from "./caldavSync.js";
import {
  sendClaimedDeliveries,
  type PushSendOptions,
  type PushDeliveryResult,
} from "./push.js";

export const SCHEDULER_TICK_MS = 15_000;
export const MAX_CLAIM_PER_TICK = 50;
export const DEFAULT_LEASE_MS = 60_000;
export const DIGEST_DOWNTIME_MS = 30 * 60 * 1000;
export const URGENT_PRIORITY = 3;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SchedulerLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface QuietHoursSetting {
  enabled: boolean;
  /** Local wall time, HH:mm:ss. */
  start: string;
  /** Local wall time, HH:mm:ss. */
  end: string;
}

export interface EnqueueOptions {
  now?: Date | (() => Date);
  owner?: string;
  taskLimit?: number;
  catchupLimit?: number;
  batchId?: string;
}

export interface EnqueueResult {
  tasksProcessed: number;
  deliveriesInserted: number;
  missedInserted: number;
  digests: number;
  activities: number;
  errors: number;
}

export interface ClaimOptions {
  now?: Date | (() => Date);
  limit?: number;
  leaseMs?: number;
}

export interface ClaimedDelivery {
  id: string;
  task_id: string;
  occurrence_key: string;
  kind: "reminder" | "digest" | "test";
  channel: "webpush" | "ntfy";
  subscription_id: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  claim_token: string | null;
  last_status: string | null;
  last_error: string | null;
  sent_at: string | null;
  rev: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TickResult {
  skipped?: "lease" | "maintenance";
  enqueued: EnqueueResult;
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  skippedDeliveries: number;
}

export interface TickOptions extends EnqueueOptions, ClaimOptions {
  skipLease?: boolean;
  send?: boolean;
  pushOptions?: PushSendOptions;
  logger?: SchedulerLogger;
  /** Enable app-scheduled nightly JSON backups (prod). Tests leave this off. */
  nightlyBackup?: boolean;
  /** Hours between automatic nightly backups (default 24). */
  nightlyBackupHours?: number;
  /** Days of activity/audit history to keep (default 90; 0 disables). */
  activityRetentionDays?: number;
  /** Run morning/weekly brief checks in this tick (default on when sending). */
  digests?: boolean;
}

export interface SchedulerHandle {
  owner: string;
  tick: () => Promise<TickResult>;
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function resolveNow(now?: Date | (() => Date)): Date {
  const value = typeof now === "function" ? now() : (now ?? new Date());
  return value instanceof Date ? value : new Date(value);
}

function asIso(now: Date): string {
  return toUtcIso(now);
}

function parseMs(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

function safeTimezone(task: TaskRow): string {
  const candidate = task.timezone || task.user_timezone || "UTC";
  return isValidTimeZone(candidate) ? candidate : "UTC";
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  user_id: string;
  list_id: string | null;
  title: string;
  notes: string | null;
  status: string;
  priority: number;
  all_day: number;
  timezone: string | null;
  user_timezone: string | null;
  remind_at: string | null;
  reminder_time_local: string | null;
  remind_offset_minutes: number | null;
  snoozed_until: string | null;
  due_at: string | null;
  due_date: string | null;
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
  missed_count: number;
  rev: number;
  updated_at: string;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  timezone: string;
}

interface ActivityInput {
  batch_id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_json: string | null;
  after_json: string | null;
  summary: string;
  created_at: string;
}

interface DeliveryInsertResult {
  inserted: number;
  ids: string[];
  skippedNoDevices: boolean;
  nextAttemptAt: string | null;
}

interface TaskProcessResult {
  deliveries: number;
  missed: number;
  digests: number;
  activities: ActivityInput[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Settings / quiet hours
// ---------------------------------------------------------------------------

function parseSettingValue(value: string): unknown {
  try {
    const once: unknown = JSON.parse(value);
    return typeof once === "string" ? JSON.parse(once) : once;
  } catch {
    return value;
  }
}

function normalizeClock(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d{2}:\d{2}$/.test(trimmed)) return `${trimmed}:00`;
  if (/^\d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  return null;
}

/** Read `settings.quietHours` / `settings.quiet_hours`. Returns null when off. */
export function readQuietHours(
  db: BetterDb,
  _userId?: string,
): QuietHoursSetting | null {
  let rows: Array<{ key: string; value: string }>;
  try {
    rows = db
      .prepare(
        `SELECT key, value FROM settings
         WHERE key IN ('quietHours', 'quiet_hours') AND deleted_at IS NULL`,
      )
      .all() as Array<{ key: string; value: string }>;
  } catch {
    return null;
  }
  for (const row of rows) {
    const parsed = parseSettingValue(row.value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    if (obj["enabled"] === false) continue;
    const start = normalizeClock(obj["start"]);
    const end = normalizeClock(obj["end"]);
    if (!start || !end || start === end) continue;
    return { enabled: true, start, end };
  }
  return null;
}

/** True when the local wall clock is inside the quiet window. */
export function isQuietHoursAt(
  now: Date,
  timezone: string,
  quiet: QuietHoursSetting | null,
): boolean {
  if (!quiet?.enabled || quiet.start === quiet.end) return false;
  const tz = isValidTimeZone(timezone) ? timezone : "UTC";
  let wallTime: string;
  try {
    wallTime = wallDateTimeInZone(now, tz).slice(11);
  } catch {
    return false;
  }
  // Compare normalized HH:mm:ss strings; both sides include seconds.
  if (quiet.start < quiet.end) {
    return wallTime >= quiet.start && wallTime < quiet.end;
  }
  return wallTime >= quiet.start || wallTime < quiet.end;
}

/**
 * Next local `end` instant strictly after `now`, resolved with Temporal
 * (`compatible`), so spring-forward 02:30 -> 03:30 and fold-first semantics
 * match the rest of the recurrence engine.
 */
export function quietHoursEnd(
  now: Date,
  timezone: string,
  quiet: QuietHoursSetting,
): Date {
  const tz = isValidTimeZone(timezone) ? timezone : "UTC";
  let date: string;
  try {
    date = wallDateTimeInZone(now, tz).slice(0, 10);
  } catch {
    date = now.toISOString().slice(0, 10);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const resolved = resolveWallTime(`${date}T${quiet.end}`, tz);
      if (resolved.instant.epochMilliseconds > now.getTime()) {
        return new Date(Number(resolved.instant.epochMilliseconds));
      }
    } catch {
      // Fall through to tomorrow / UTC fallback.
    }
    date = addWallDays(date, 1);
  }
  return new Date(now.getTime() + 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function insertActivity(
  db: BetterDb,
  input: ActivityInput,
): ActivityEventRow {
  const info = db
    .prepare(
      `INSERT INTO activity
        (batch_id, actor, action, entity_type, entity_id, before_json, after_json, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.batch_id,
      input.actor,
      input.action,
      input.entity_type,
      input.entity_id,
      input.before_json,
      input.after_json,
      input.summary,
      input.created_at,
    );
  return {
    seq: Number(info.lastInsertRowid),
    batch_id: input.batch_id,
    actor: input.actor,
    action: input.action,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    before_json: input.before_json,
    after_json: input.after_json,
    summary: input.summary,
    created_at: input.created_at,
  };
}

function activity(
  batchId: string,
  owner: string,
  action: string,
  task: TaskRow,
  nowIso: string,
  after: Record<string, unknown>,
  summary: string,
): ActivityInput {
  return {
    batch_id: batchId,
    actor: "scheduler",
    action,
    entity_type: "task",
    entity_id: task.id,
    before_json: null,
    after_json: JSON.stringify({ ...after, rev: task.rev + 1 }),
    summary,
    created_at: nowIso,
  };
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

function recurrenceInputFor(task: TaskRow): RecurrenceInput | null {
  if (!task.rrule || !task.dtstart_local) return null;
  const timezone = safeTimezone(task);
  try {
    return {
      rrule: task.rrule,
      dtstartLocal: task.dtstart_local,
      timezone,
      count: task.recurrence_count,
      untilUtc: isUtcIso(task.recurrence_until_utc ?? "")
        ? task.recurrence_until_utc
        : null,
      untilDate: task.recurrence_until_date,
      wkst: task.wkst,
      clampPolicy: task.clamp_policy === "last-day" ? "last-day" : "skip",
      allDay: task.all_day === 1,
      reminderTimeLocal: task.reminder_time_local,
    };
  } catch {
    return null;
  }
}

interface DueOccurrence {
  occurrenceKey: string;
  instantIso: string;
  local: string;
}

function dueFromOccurrence(occurrence: Occurrence): DueOccurrence {
  return {
    occurrenceKey: occurrence.occurrenceKey,
    instantIso: occurrence.instantIso,
    local: occurrence.local,
  };
}

/**
 * Occurrences at or after the stored boundary that are already due. The first
 * element is normally the stored `next_occurrence_at` itself.
 */
function collectDueOccurrences(
  input: RecurrenceInput,
  nextOccurrenceAt: string,
  nowIso: string,
  catchupLimit: number,
): DueOccurrence[] {
  const after = new Date(Date.parse(nextOccurrenceAt) - 1).toISOString();
  const occurrences = generateOccurrences(input, {
    after,
    limit: Math.max(1, catchupLimit),
  });
  return occurrences
    .filter((occurrence) => occurrence.instantIso <= nowIso)
    .map(dueFromOccurrence);
}

function storedOccurrenceKey(task: TaskRow): string {
  if (task.all_day === 1) {
    return (
      task.next_occurrence_local?.slice(0, 10) ??
      task.due_date ??
      task.next_occurrence_at?.slice(0, 10) ??
      "1970-01-01"
    );
  }
  return task.next_occurrence_at ?? new Date(0).toISOString();
}

function exceptionForOccurrence(
  db: BetterDb,
  taskId: string,
  occurrenceKey: string,
): { status: string; completedAt: string | null } | null {
  try {
    const row = db
      .prepare(
        `SELECT status, completed_at FROM task_recurrence_exceptions
          WHERE task_id = ? AND recurrence_id = ? AND deleted_at IS NULL
          LIMIT 1`,
      )
      .get(taskId, occurrenceKey) as
      | { status: string | null; completed_at: string | null }
      | undefined;
    return row ? { status: row.status ?? "open", completedAt: row.completed_at } : null;
  } catch {
    return null;
  }
}

function recordExceptionResolution(
  db: BetterDb,
  task: TaskRow,
  occurrenceKey: string,
  status: "completed" | "cancelled",
  completedAt: string,
  nowIsoValue: string,
): boolean {
  try {
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO task_completions
           (id, task_id, occurrence_key, status, completed_at, source, rev, created_at)
         VALUES (?, ?, ?, ?, ?, 'user', 1, ?)`,
      )
      .run(
        newId(),
        task.id,
        occurrenceKey,
        status === "completed" ? "completed" : "skipped",
        completedAt,
        nowIsoValue,
      );
    return info.changes > 0;
  } catch {
    return false;
  }
}

function oneOffOccurrenceKey(task: TaskRow, instantIso: string): string {
  if (task.all_day === 1) {
    return (
      task.next_occurrence_local?.slice(0, 10) ??
      task.due_date ??
      instantIso.slice(0, 10)
    );
  }
  return instantIso;
}

/**
 * Fallback instant for tasks created with only a due date (no armed
 * `remind_at` / `next_occurrence_at`, e.g. legacy rows). Timed tasks use
 * `due_at` (+ offset); all-day tasks resolve `due_date + reminder_time_local`
 * in the task timezone (+ offset). Returns null when there is no usable due
 * date or it is still in the future.
 */
function allDayReminderInstant(
  task: TaskRow,
  timezone: string,
): string | null {
  const dueDate =
    task.due_date && isWallDate(task.due_date) ? task.due_date : null;
  if (!dueDate) return null;
  let time = DEFAULT_ALL_DAY_REMINDER_TIME;
  try {
    if (task.reminder_time_local) {
      time = normalizeWallTime(task.reminder_time_local);
    }
  } catch {
    time = DEFAULT_ALL_DAY_REMINDER_TIME;
  }
  try {
    const resolved = resolveAllDayReminder(dueDate, time, timezone);
    return applyReminderOffset(
      resolved.instantIso,
      task.remind_offset_minutes ?? 0,
    );
  } catch {
    return null;
  }
}

function dueFallbackInstant(task: TaskRow): string | null {
  if (task.all_day === 1) {
    return allDayReminderInstant(task, safeTimezone(task));
  }
  if (!task.due_at || !isUtcIso(task.due_at)) return null;
  try {
    return applyReminderOffset(task.due_at, task.remind_offset_minutes ?? 0);
  } catch {
    return null;
  }
}

/**
 * Resolve a stored all-day wall local (recurring series created before the
 * armed-instant fix) to its UTC instant in the task timezone.
 */
function resolveStoredAllDayLocal(task: TaskRow): string | null {
  const local = task.next_occurrence_local ?? task.due_date;
  if (!local) return null;
  const date = local.slice(0, 10);
  if (!isWallDate(date)) return null;
  const tz = safeTimezone(task);
  let time = DEFAULT_ALL_DAY_REMINDER_TIME;
  try {
    if (task.reminder_time_local) {
      time = normalizeWallTime(task.reminder_time_local);
    }
  } catch {
    time = DEFAULT_ALL_DAY_REMINDER_TIME;
  }
  try {
    const resolved = resolveAllDayReminder(date, time, tz);
    return applyReminderOffset(
      resolved.instantIso,
      task.remind_offset_minutes ?? 0,
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Delivery enqueue
// ---------------------------------------------------------------------------

/**
 * ntfy is one workspace topic configured by the owner, not a per-member
 * destination. Publish only tasks the owner can read so member-private
 * reminder titles never leave their account; members use Web Push.
 */
function ntfyRecipientCanReadTask(db: BetterDb, task: TaskRow): boolean {
  try {
    const owner = db
      .prepare(
        "SELECT id FROM users WHERE deleted_at IS NULL AND role = 'owner' ORDER BY created_at ASC, id ASC LIMIT 1",
      )
      .get() as { id: string } | undefined;
    // Fail closed: without a confirmed owner there is no safe workspace
    // recipient for the shared topic.
    if (!owner) return false;
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM tasks t
          WHERE t.id = ? AND (${TASK_ACCESS_SQL}) AND t.deleted_at IS NULL`,
      )
      .get(task.id, owner.id, owner.id, owner.id) as { ok: number } | undefined;
    return Boolean(row);
  } catch {
    // If access cannot be established, do not publish to the shared topic.
    return false;
  }
}

function createDeliveries(
  db: BetterDb,
  task: TaskRow,
  occurrenceKey: string,
  kind: "reminder" | "digest",
  ctx: ProcessContext,
  subscriptions: SubscriptionRow[] = ctx.subscriptions,
  allowNtfy = true,
): DeliveryInsertResult {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO deliveries
       (id, task_id, occurrence_key, kind, channel, subscription_id, status,
        attempts, next_attempt_at, last_status, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?)`,
  );
  const nowIso = ctx.nowIso;
  const attemptForSubscription = (subscription: SubscriptionRow): string =>
    nextAttemptFor(
      task,
      ctx.now,
      ctx.nowIso,
      ctx.quiet,
      subscription.timezone,
    );

  const ids: string[] = [];
  let inserted = 0;
  const ntfy =
    allowNtfy && ntfyRecipientCanReadTask(db, task)
      ? readNtfyConfig(db, task.user_id)
      : null;

  if (subscriptions.length === 0 && !ntfy) {
    // Honest ledger state: the reminder was due but no channel could receive
    // it. A skipped row never enters the send queue and records why.
    const id = newId();
    const info = insert.run(
      id,
      task.id,
      occurrenceKey,
      kind,
      "webpush",
      "",
      "skipped",
      null,
      "no push subscriptions or ntfy channel",
      nowIso,
      nowIso,
    );
    if (info.changes > 0) {
      inserted += 1;
      ids.push(id);
    }
    return { inserted, ids, skippedNoDevices: true, nextAttemptAt: null };
  }

  let firstAttempt: string | null = null;
  for (const subscription of subscriptions) {
    const nextAttemptAt = attemptForSubscription(subscription);
    firstAttempt ??= nextAttemptAt;
    const id = newId();
    const info = insert.run(
      id,
      task.id,
      occurrenceKey,
      kind,
      "webpush",
      subscription.id,
      "pending",
      nextAttemptAt,
      null,
      nowIso,
      nowIso,
    );
    if (info.changes > 0) {
      inserted += 1;
      ids.push(id);
    }
  }
  if (ntfy) {
    // ntfy is one workspace topic owned by the workspace owner, so its quiet
    // check uses the owner's zone rather than the task creator's zone.
    const workspaceOwner = db
      .prepare(
        "SELECT timezone FROM users WHERE deleted_at IS NULL AND role = 'owner' ORDER BY created_at ASC, id ASC LIMIT 1",
      )
      .get() as { timezone: string } | undefined;
    const nextAttemptAt = nextAttemptFor(
      task,
      ctx.now,
      ctx.nowIso,
      ctx.quiet,
      workspaceOwner?.timezone ?? task.user_timezone,
    );
    firstAttempt ??= nextAttemptAt;
    const id = newId();
    const info = insert.run(
      id,
      task.id,
      occurrenceKey,
      kind,
      "ntfy",
      "ntfy",
      "pending",
      nextAttemptAt,
      null,
      nowIso,
      nowIso,
    );
    if (info.changes > 0) {
      inserted += 1;
      ids.push(id);
    }
  }
  return {
    inserted,
    ids,
    skippedNoDevices: false,
    nextAttemptAt: firstAttempt ?? nowIso,
  };
}

function enabledSubscriptionsFor(
  db: BetterDb,
  task: TaskRow,
): SubscriptionRow[] {
  // Shared lists notify every member's devices; private tasks stay owner-only.
  if (task.list_id) {
    return db
      .prepare(
        `SELECT DISTINCT s.id, s.user_id, COALESCE(u.timezone, 'UTC') AS timezone
           FROM push_subscriptions s
           JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
          WHERE s.enabled = 1 AND s.deleted_at IS NULL
            AND (
              s.user_id = ?
              OR s.user_id = (
                SELECT l.user_id FROM lists l WHERE l.id = ?
              )
              OR s.user_id IN (
                SELECT lm.user_id FROM list_members lm WHERE lm.list_id = ?
              )
            )
          ORDER BY s.created_at ASC`,
      )
      .all(task.user_id, task.list_id, task.list_id) as SubscriptionRow[];
  }
  return db
    .prepare(
      `SELECT s.id, s.user_id, COALESCE(u.timezone, 'UTC') AS timezone
         FROM push_subscriptions s
         JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
        WHERE s.user_id = ? AND s.enabled = 1 AND s.deleted_at IS NULL
        ORDER BY s.created_at ASC`,
    )
    .all(task.user_id) as SubscriptionRow[];
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

function selectDueTasks(
  db: BetterDb,
  nowIso: string,
  limit: number,
): TaskRow[] {
  return db
    .prepare(
      `SELECT t.*, u.timezone AS user_timezone
       FROM tasks t
       JOIN users u ON u.id = t.user_id
       WHERE t.deleted_at IS NULL
         AND t.status = 'open'
         AND (t.snoozed_until IS NULL OR t.snoozed_until <= ?)
         AND (
           (t.next_occurrence_at IS NOT NULL AND t.next_occurrence_at <= ?)
           OR (t.remind_at IS NOT NULL AND t.remind_at <= ?)
           OR (t.due_at IS NOT NULL AND t.due_at <= ?)
           OR (t.all_day = 1 AND t.due_date IS NOT NULL)
           OR (t.rrule IS NOT NULL AND t.next_occurrence_local IS NOT NULL)
         )
       ORDER BY COALESCE(t.next_occurrence_at, t.remind_at, t.due_at) ASC
       LIMIT ?`,
    )
    .all(nowIso, nowIso, nowIso, nowIso, limit) as TaskRow[];
}

function nextAttemptFor(
  task: TaskRow,
  now: Date,
  nowIso: string,
  quiet: QuietHoursSetting | null,
  recipientTimezone?: string | null,
): string {
  if (!quiet || task.priority >= URGENT_PRIORITY) return nowIso;
  // Quiet hours belong to the person being notified, not the task owner.
  const tz =
    recipientTimezone && isValidTimeZone(recipientTimezone)
      ? recipientTimezone
      : safeTimezone(task);
  if (!isQuietHoursAt(now, tz, quiet)) return nowIso;
  return toUtcIso(quietHoursEnd(now, tz, quiet));
}

interface ProcessContext {
  batchId: string;
  owner: string;
  now: Date;
  nowIso: string;
  catchupLimit: number;
  quiet: QuietHoursSetting | null;
  subscriptions: SubscriptionRow[];
}

function processRecurringTask(
  db: BetterDb,
  task: TaskRow,
  ctx: ProcessContext,
): TaskProcessResult {
  const input = recurrenceInputFor(task);
  const result: TaskProcessResult = {
    deliveries: 0,
    missed: 0,
    digests: 0,
    activities: [],
  };
  if (!input) {
    // A task with `next_occurrence_at` but no usable rule cannot be advanced
    // by the recurrence engine. Deliver the stored boundary once, then clear
    // it so the next tick does not loop forever.
    result.activities.push(
      activity(
        ctx.batchId,
        ctx.owner,
        "scheduler.error",
        task,
        ctx.nowIso,
        { error: "invalid recurrence", nextOccurrenceAt: task.next_occurrence_at },
        `Recurrence could not be resolved for "${task.title}"`,
      ),
    );
    const occurrenceKey = storedOccurrenceKey(task);
    const created = createDeliveries(
      db,
      task,
      occurrenceKey,
      "reminder",
      ctx,
    );
    result.deliveries += created.inserted;
    if (created.inserted > 0) {
      result.activities.push(
        activity(
          ctx.batchId,
          ctx.owner,
          "reminder.enqueued",
          task,
          ctx.nowIso,
          {
            occurrenceKey,
            deliveryIds: created.ids,
            skippedNoDevices: created.skippedNoDevices,
          },
          created.skippedNoDevices
            ? `Reminder due, no devices: "${task.title}"`
            : `Reminder queued: "${task.title}"`,
        ),
      );
    }
    db.prepare(
      `UPDATE tasks
       SET next_occurrence_at = NULL, next_occurrence_local = NULL,
           series_ended_at = ?, rev = rev + 1, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
    ).run(ctx.nowIso, ctx.nowIso, task.id);
    return result;
  }

  const storedAt = task.next_occurrence_at;
  if (!storedAt) return result;

  let rawDue = collectDueOccurrences(
    input,
    storedAt,
    ctx.nowIso,
    ctx.catchupLimit,
  );
  if (rawDue.length === 0) {
    // The stored boundary is not a valid occurrence (e.g. a timezone change
    // left an old instant behind). Deliver that boundary once and advance
    // from now, rather than losing the reminder.
    rawDue = [
      {
        occurrenceKey: storedOccurrenceKey(task),
        instantIso: storedAt,
        local: task.next_occurrence_local ?? storedAt,
      },
    ];
  }

  // A completed or cancelled per-occurrence exception suppresses the base
  // reminder for that occurrence. The exception's own completion row keeps
  // the series history honest; open overridden occurrences still use the base
  // reminder timing in this MVP.
  const due = rawDue.filter((occurrence) => {
    const exception = exceptionForOccurrence(
      db,
      task.id,
      occurrence.occurrenceKey,
    );
    if (!exception || exception.status === "open") return true;
    if (exception.status === "done" || exception.status === "cancelled") {
      recordExceptionResolution(
        db,
        task,
        occurrence.occurrenceKey,
        exception.status === "done" ? "completed" : "cancelled",
        exception.completedAt ?? ctx.nowIso,
        ctx.nowIso,
      );
      return false;
    }
    return true;
  });

  const completionMode = task.recurrence_mode === "completion";
  if (completionMode) {
    if (due.length === 0) return result;
    const current = due[0]!;
    const created = createDeliveries(
      db,
      task,
      current.occurrenceKey,
      "reminder",
      ctx,
    );
    result.deliveries += created.inserted;
    if (created.inserted > 0) {
      result.activities.push(
        activity(
          ctx.batchId,
          ctx.owner,
          "reminder.enqueued",
          task,
          ctx.nowIso,
          {
            occurrenceKey: current.occurrenceKey,
            deliveryIds: created.ids,
            recurrenceMode: "completion",
            skippedNoDevices: created.skippedNoDevices,
          },
          created.skippedNoDevices
            ? `Reminder due, no devices: "${task.title}"`
            : `Reminder queued: "${task.title}"`,
        ),
      );
    }
    return result;
  }

  if (due.length > 0) {
    const lateMs = ctx.now.getTime() - parseMs(due[0]!.instantIso);
    const digest = due.length >= 2 || lateMs > DIGEST_DOWNTIME_MS;
    const insertion = digest ? due[due.length - 1]! : due[0]!;

    if (digest) {
      const insertMissed = db.prepare(
        `INSERT OR IGNORE INTO task_completions
           (id, task_id, occurrence_key, status, completed_at, source, rev, created_at)
         VALUES (?, ?, ?, 'missed', ?, 'scheduler', 1, ?)`,
      );
      for (const occurrence of due) {
        const info = insertMissed.run(
          newId(),
          task.id,
          occurrence.occurrenceKey,
          occurrence.instantIso,
          ctx.nowIso,
        );
        if (info.changes > 0) {
          result.missed += 1;
          result.activities.push(
            activity(
              ctx.batchId,
              ctx.owner,
              "task.missed",
              task,
              ctx.nowIso,
              {
                occurrenceKey: occurrence.occurrenceKey,
                status: "missed",
                missedAt: occurrence.instantIso,
              },
              `Missed: "${task.title}" (${occurrence.occurrenceKey})`,
            ),
          );
        }
      }
    }

    const created = createDeliveries(
      db,
      task,
      insertion.occurrenceKey,
      digest ? "digest" : "reminder",
      ctx,
    );
    result.deliveries += created.inserted;
    if (digest) result.digests += created.inserted;
    if (created.inserted > 0) {
      result.activities.push(
        activity(
          ctx.batchId,
          ctx.owner,
          digest ? "reminder.digest" : "reminder.enqueued",
          task,
          ctx.nowIso,
          {
            occurrenceKey: insertion.occurrenceKey,
            deliveryIds: created.ids,
            kind: digest ? "digest" : "reminder",
            missedOccurrences: digest ? due.length : 0,
            skippedNoDevices: created.skippedNoDevices,
          },
          created.skippedNoDevices
            ? `Reminder due, no devices: "${task.title}"`
            : digest
              ? `Digest queued: "${task.title}" (${due.length} missed)`
              : `Reminder queued: "${task.title}"`,
        ),
      );
    }
  }

  const next = nextOccurrenceAfter(input, ctx.nowIso);
  db.prepare(
    `UPDATE tasks
     SET next_occurrence_at = ?, next_occurrence_local = ?,
         occurrence_seq = occurrence_seq + ?,
         missed_count = missed_count + ?,
         series_ended_at = CASE WHEN ? IS NULL THEN ? ELSE series_ended_at END,
         rev = rev + 1, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(
    next?.instantIso ?? null,
    next?.local ?? null,
    due.length,
    result.missed,
    next?.instantIso ?? null,
    ctx.nowIso,
    ctx.nowIso,
    task.id,
  );

  return result;
}

function processOneOffTask(
  db: BetterDb,
  task: TaskRow,
  ctx: ProcessContext,
): TaskProcessResult {
  const result: TaskProcessResult = {
    deliveries: 0,
    missed: 0,
    digests: 0,
    activities: [],
  };
  const dueKeys: Array<{
    key: string;
    source: "next" | "remind" | "due_at" | "due_date";
  }> = [];

  if (task.next_occurrence_at && task.next_occurrence_at <= ctx.nowIso) {
    dueKeys.push({
      key: oneOffOccurrenceKey(task, task.next_occurrence_at),
      source: "next",
    });
  }
  if (task.remind_at && task.remind_at <= ctx.nowIso) {
    const key = oneOffOccurrenceKey(task, task.remind_at);
    if (!dueKeys.some((entry) => entry.key === key)) {
      dueKeys.push({ key, source: "remind" });
    }
  }
  // Due-date fallback for tasks created with only dueAt/dueDate (legacy rows
  // or clients that bypass derivation). The unique delivery key keeps a
  // repeat tick a no-op; the armed fields are backfilled below.
  if (dueKeys.length === 0) {
    const fallbackInstant = dueFallbackInstant(task);
    if (fallbackInstant && fallbackInstant <= ctx.nowIso) {
      const key =
        task.all_day === 1
          ? (task.due_date?.slice(0, 10) ??
            task.next_occurrence_local?.slice(0, 10) ??
            fallbackInstant.slice(0, 10))
          : fallbackInstant;
      dueKeys.push({
        key,
        source: task.all_day === 1 ? "due_date" : "due_at",
      });
    }
  }
  // All-day reminders are wall-clock preferences: a shared-list member in
  // another zone gets their own 09:00, not the owner's. An explicit task
  // timezone still pins the wall clock for everyone.
  let scopedSubscriptions = ctx.subscriptions;
  let allowNtfy = true;
  if (task.all_day === 1 && task.due_date) {
    const explicitTimezone =
      task.timezone && isValidTimeZone(task.timezone) ? task.timezone : null;
    const instantFor = (timezone: string): string | null =>
      allDayReminderInstant(task, explicitTimezone ?? timezone);
    const ownerTimezone =
      task.user_timezone && isValidTimeZone(task.user_timezone)
        ? task.user_timezone
        : (task.timezone ?? "UTC");
    // Only redistribute timing when the reminder was derived from the
    // all-day wall-clock preference. A client-supplied absolute TRIGGER wins
    // and must fire at its stored instant for every recipient.
    const derivedOwner = instantFor(ownerTimezone);
    const derivedTiming =
      task.remind_at === null ||
      (derivedOwner !== null &&
        Math.abs(Date.parse(task.remind_at) - Date.parse(derivedOwner)) <
          1_000);
    if (derivedTiming) {
      const ownerDue = derivedOwner !== null && derivedOwner <= ctx.nowIso;
      scopedSubscriptions = ctx.subscriptions.filter((subscription) => {
        const instant = instantFor(subscription.timezone);
        return instant !== null && instant <= ctx.nowIso;
      });
      allowNtfy = ownerDue;
      if (scopedSubscriptions.length === 0 && !ownerDue) return result;
      const key = task.due_date.slice(0, 10);
      if (!dueKeys.some((entry) => entry.key === key)) {
        dueKeys.push({ key, source: "due_date" });
      }
    }
  }

  if (dueKeys.length === 0) return result;
  const clearRemind =
    Boolean(task.remind_at) && task.remind_at! <= ctx.nowIso;

  for (const entry of dueKeys) {
    const created = createDeliveries(
      db,
      task,
      entry.key,
      "reminder",
      ctx,
      scopedSubscriptions,
      allowNtfy,
    );
    result.deliveries += created.inserted;
    if (created.inserted > 0) {
      result.activities.push(
        activity(
          ctx.batchId,
          ctx.owner,
          "reminder.enqueued",
          task,
          ctx.nowIso,
          {
            occurrenceKey: entry.key,
            deliveryIds: created.ids,
            source: entry.source,
            skippedNoDevices: created.skippedNoDevices,
          },
          created.skippedNoDevices
            ? `Reminder due, no devices: "${task.title}"`
            : `Reminder queued: "${task.title}"`,
        ),
      );
    }
  }

  // Avoid rev churn on repeat ticks: fallback due_at/due_date rows stay
  // selectable (due instant <= now) after the first enqueue, but the unique
  // delivery key makes repeats a no-op. Only touch the task when we actually
  // enqueued something or cleared an armed field.
  const hasNextSource = dueKeys.some((entry) => entry.source === "next");
  if (result.deliveries === 0 && !clearRemind && !hasNextSource) {
    return result;
  }

  db.prepare(
    `UPDATE tasks
     SET next_occurrence_at = CASE WHEN ? THEN NULL ELSE next_occurrence_at END,
         next_occurrence_local = CASE WHEN ? THEN NULL ELSE next_occurrence_local END,
         remind_at = CASE WHEN ? THEN NULL ELSE remind_at END,
         occurrence_seq = occurrence_seq + ?,
         rev = rev + 1, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(
    hasNextSource ? 1 : 0,
    hasNextSource ? 1 : 0,
    clearRemind ? 1 : 0,
    // One occurrence, regardless of how many recipient rows it produced.
    result.deliveries > 0 ? 1 : 0,
    ctx.nowIso,
    task.id,
  );

  return result;
}

/**
 * A recurring task's `remind_at` is an alert for the upcoming occurrence
 * (for example due time minus an offset). Deliver it under the SAME
 * occurrence key as the scheduled occurrence so the unique key prevents a
 * second push when `next_occurrence_at` catches up. It never advances the
 * recurrence on its own.
 */
function processRecurringRemindAt(
  db: BetterDb,
  task: TaskRow,
  ctx: ProcessContext,
): TaskProcessResult {
  const result: TaskProcessResult = {
    deliveries: 0,
    missed: 0,
    digests: 0,
    activities: [],
  };
  if (!task.remind_at || task.remind_at > ctx.nowIso) return result;

  const occurrenceKey = task.next_occurrence_at
    ? storedOccurrenceKey(task)
    : oneOffOccurrenceKey(task, task.remind_at);
  const created = createDeliveries(
    db,
    task,
    occurrenceKey,
    "reminder",
    ctx,
  );
  result.deliveries += created.inserted;
  if (created.inserted > 0) {
    result.activities.push(
      activity(
        ctx.batchId,
        ctx.owner,
        "reminder.enqueued",
        task,
        ctx.nowIso,
        {
          occurrenceKey,
          deliveryIds: created.ids,
          source: "remind_at",
          skippedNoDevices: created.skippedNoDevices,
        },
        created.skippedNoDevices
          ? `Reminder due, no devices: "${task.title}"`
          : `Reminder queued: "${task.title}"`,
      ),
    );
  }

  db.prepare(
    `UPDATE tasks
     SET remind_at = NULL, rev = rev + 1, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(ctx.nowIso, task.id);

  return result;
}

function mergeResults(
  target: TaskProcessResult,
  source: TaskProcessResult,
): TaskProcessResult {
  target.deliveries += source.deliveries;
  target.missed += source.missed;
  target.digests += source.digests;
  target.activities.push(...source.activities);
  return target;
}

function clearRemindAt(
  db: BetterDb,
  task: TaskRow,
  nowIso: string,
): void {
  db.prepare(
    `UPDATE tasks
     SET remind_at = NULL, rev = rev + 1, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(nowIso, task.id);
}

function processTask(
  db: BetterDb,
  task: TaskRow,
  ctx: ProcessContext,
): TaskProcessResult {
  if (task.rrule) {
    if (task.next_occurrence_at) {
      const result: TaskProcessResult = {
        deliveries: 0,
        missed: 0,
        digests: 0,
        activities: [],
      };
      // Only advance the recurrence when the occurrence itself is due. A future
      // occurrence selected because `remind_at` fired must not be consumed
      // early.
      if (task.next_occurrence_at <= ctx.nowIso) {
        mergeResults(result, processRecurringTask(db, task, ctx));
        // remind_at belongs to the occurrence that just fired; the recurrence
        // path already enqueued its reminder/digest, so clear it rather than
        // creating a second push for an older occurrence key.
        if (task.remind_at && task.remind_at <= ctx.nowIso) {
          clearRemindAt(db, task, ctx.nowIso);
        }
      } else {
        mergeResults(result, processRecurringRemindAt(db, task, ctx));
      }
      return result;
    }
    // Armless recurring series (legacy rows without next_occurrence_at).
    // Prefer the stored wall local (all-day series) resolved in the task
    // timezone; otherwise fall through to the due-date fallback so at least
    // one reminder fires instead of none.
    if (task.remind_at && task.remind_at <= ctx.nowIso) {
      return processRecurringRemindAt(db, task, ctx);
    }
    const storedInstant = resolveStoredAllDayLocal(task);
    if (storedInstant && storedInstant <= ctx.nowIso) {
      // Backfill the real resolved instant so the next tick uses the fast
      // UTC path, then process as a due recurring boundary.
      try {
        db.prepare(
          `UPDATE tasks SET next_occurrence_at = ?, rev = rev + 1, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        ).run(storedInstant, ctx.nowIso, task.id);
        const armed: TaskRow = {
          ...task,
          next_occurrence_at: storedInstant,
        };
        return processRecurringTask(db, armed, ctx);
      } catch {
        // Fall through to one-off fallback.
      }
    }
    // Last resort: due-date fallback (one-off path) guarantees a delivery
    // row rather than silence for legacy series.
    return processOneOffTask(db, task, ctx);
  }
  return processOneOffTask(db, task, ctx);
}

/**
 * Phase 1: enqueue due work in one `BEGIN IMMEDIATE` transaction.
 *
 * Activity rows are returned through the transaction and published only
 * after commit, so a rolled-back tick can never leak SSE events.
 */
export function enqueueDueWork(
  db: BetterDb,
  options: EnqueueOptions = {},
): EnqueueResult {
  const now = resolveNow(options.now);
  const nowIso = asIso(now);
  const owner = options.owner ?? "scheduler";
  const taskLimit = Math.max(1, options.taskLimit ?? 500);
  const catchupLimit = Math.max(1, Math.min(2_000, options.catchupLimit ?? 500));
  const batchId = options.batchId ?? newId();
  const quiet = readQuietHours(db);

  const summary: EnqueueResult = {
    tasksProcessed: 0,
    deliveriesInserted: 0,
    missedInserted: 0,
    digests: 0,
    activities: 0,
    errors: 0,
  };
  const published: ActivityEventRow[] = [];
  const subscriptionCache = new Map<string, SubscriptionRow[]>();

  const run = db.transaction(() => {
    const tasks = selectDueTasks(db, nowIso, taskLimit);
    for (const task of tasks) {
      summary.tasksProcessed += 1;
      const cacheKey = `${task.user_id}|${task.list_id ?? ""}`;
      let subscriptions = subscriptionCache.get(cacheKey);
      if (!subscriptions) {
        subscriptions = enabledSubscriptionsFor(db, task);
        subscriptionCache.set(cacheKey, subscriptions);
      }
      const ctx: ProcessContext = {
        batchId,
        owner,
        now,
        nowIso,
        catchupLimit,
        quiet,
        subscriptions,
      };

      let localActivities: ActivityInput[] = [];
      try {
        // A savepoint per task keeps one broken recurrence from rolling back
        // the other reminders in the same tick.
        const taskTx = db.transaction(() => processTask(db, task, ctx));
        const processed = taskTx();
        summary.deliveriesInserted += processed.deliveries;
        summary.missedInserted += processed.missed;
        summary.digests += processed.digests;
        localActivities = processed.activities;
      } catch (error) {
        summary.errors += 1;
        localActivities = [
          activity(
            batchId,
            owner,
            "scheduler.error",
            task,
            nowIso,
            {
              error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
            },
            `Scheduler could not process "${task.title}"`,
          ),
        ];
      }

      for (const input of localActivities) {
        try {
          published.push(insertActivity(db, input));
          summary.activities += 1;
        } catch {
          summary.errors += 1;
        }
      }
    }

    try {
      db.prepare(
        `INSERT INTO scheduler_state (id, last_tick_at)
         VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET last_tick_at = excluded.last_tick_at`,
      ).run(nowIso);
      if (summary.missedInserted > 0 || summary.digests > 0) {
        db.prepare(
          `UPDATE scheduler_state SET last_catchup_at = ? WHERE id = 1`,
        ).run(nowIso);
      }
    } catch {
      // scheduler_state is best-effort bookkeeping.
    }
  });

  run.immediate();
  publishActivity(published);
  return summary;
}

// ---------------------------------------------------------------------------
// Lease / claim
// ---------------------------------------------------------------------------

/** Take or renew the single-writer scheduler lease. */
export function acquireSchedulerLease(
  db: BetterDb,
  owner: string,
  now: Date = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
): boolean {
  const nowIso = asIso(now);
  const until = asIso(new Date(now.getTime() + leaseMs));
  const info = db
    .prepare(
      `INSERT INTO scheduler_state (id, lease_owner, lease_until, last_tick_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         lease_owner = excluded.lease_owner,
         lease_until = excluded.lease_until,
         last_tick_at = excluded.last_tick_at
       WHERE scheduler_state.lease_until IS NULL
          OR scheduler_state.lease_until <= ?
          OR scheduler_state.lease_owner = ?`,
    )
    .run(owner, until, nowIso, nowIso, owner);
  return info.changes > 0;
}

export function releaseSchedulerLease(
  db: BetterDb,
  owner: string,
): void {
  try {
    db.prepare(
      `UPDATE scheduler_state
       SET lease_owner = NULL, lease_until = NULL
       WHERE id = 1 AND lease_owner = ?`,
    ).run(owner);
  } catch {
    // best effort during shutdown
  }
}

/**
 * Phase 2: reclaim stale `sending` rows, then claim up to 50 due rows.
 * `attempts` is incremented at claim time, so a crash still counts as a try
 * and cannot loop forever.
 */
export function claimDeliveries(
  db: BetterDb,
  options: ClaimOptions = {},
): ClaimedDelivery[] {
  const now = resolveNow(options.now);
  const nowIso = asIso(now);
  const limit = Math.max(1, Math.min(500, options.limit ?? MAX_CLAIM_PER_TICK));
  const leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  const leaseUntil = asIso(new Date(now.getTime() + leaseMs));

  const run = db.transaction(() => {
    // Reclaim expired leases. The old claim_token is cleared, so the previous
    // worker's markSent() guard fails even if it is still alive.
    db.prepare(
      `UPDATE deliveries
       SET status = 'retry',
           claim_token = NULL,
           lease_until = NULL,
           last_error = COALESCE(last_error, 'stale sending lease reclaimed'),
           updated_at = ?
       WHERE status = 'sending'
         AND (lease_until IS NULL OR lease_until < ?)`,
    ).run(nowIso, nowIso);

    // Dead-letter anything that already exhausted its attempts instead of
    // handing it to a sender forever.
    db.prepare(
      `UPDATE deliveries
       SET status = 'dead',
           claim_token = NULL,
           lease_until = NULL,
           last_error = COALESCE(last_error, 'five failed attempts'),
           updated_at = ?
       WHERE status IN ('pending', 'retry')
         AND attempts >= 5`,
    ).run(nowIso);

    const due = db
      .prepare(
        `SELECT id FROM deliveries
         WHERE status IN ('pending', 'retry')
           AND deleted_at IS NULL
           AND attempts < 5
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY COALESCE(next_attempt_at, created_at) ASC
         LIMIT ?`,
      )
      .all(nowIso, limit) as Array<{ id: string }>;

    const update = db.prepare(
      `UPDATE deliveries
       SET status = 'sending',
           claim_token = ?,
           lease_until = ?,
           attempts = attempts + 1,
           updated_at = ?
       WHERE id = ?
         AND status IN ('pending', 'retry')
         AND attempts < 5`,
    );

    const claimed: ClaimedDelivery[] = [];
    for (const row of due) {
      const token = newId();
      const info = update.run(token, leaseUntil, nowIso, row.id);
      if (info.changes === 0) continue;
      const claimedRow = db
        .prepare("SELECT * FROM deliveries WHERE id = ?")
        .get(row.id) as ClaimedDelivery | undefined;
      if (claimedRow) claimed.push(claimedRow);
    }
    return claimed;
  });

  return run.immediate();
}

/**
 * Mark a delivery sent ONLY while this worker still owns the claim. Returns
 * false for a stale/reclaimed token — the losing worker must not flip state.
 */
export function markSent(
  db: BetterDb,
  deliveryId: string,
  claimToken: string,
  now: Date = new Date(),
): boolean {
  const info = db
    .prepare(
      `UPDATE deliveries
       SET status = 'sent',
           sent_at = ?,
           lease_until = NULL,
           claim_token = NULL,
           last_status = COALESCE(last_status, 'sent'),
           last_error = NULL,
           updated_at = ?,
           rev = rev + 1
       WHERE id = ? AND claim_token = ? AND status = 'sending'`,
    )
    .run(asIso(now), asIso(now), deliveryId, claimToken);
  return info.changes === 1;
}

// ---------------------------------------------------------------------------
// Tick / process lifecycle
// ---------------------------------------------------------------------------

function emptyEnqueueResult(): EnqueueResult {
  return {
    tasksProcessed: 0,
    deliveriesInserted: 0,
    missedInserted: 0,
    digests: 0,
    activities: 0,
    errors: 0,
  };
}

/**
 * Re-check quiet hours and task state after claim, before touching the
 * network. Settings can change between enqueue and send, and M1 may complete
 * or delete a task while its delivery is queued. Held rows go back to
 * `pending` with `next_attempt_at = quiet end`; the claim attempt is undone
 * so quiet hours never consume one of the five failures.
 */
function filterClaimedForSend(
  db: BetterDb,
  claimed: ClaimedDelivery[],
  now: Date,
  quiet: QuietHoursSetting | null,
): ClaimedDelivery[] {
  if (claimed.length === 0) return claimed;
  const nowIso = asIso(now);
  const out: ClaimedDelivery[] = [];

  for (const delivery of claimed) {
    let row:
      | {
          priority: number;
          timezone: string | null;
          user_timezone: string | null;
          recipient_timezone: string | null;
          owner_timezone: string | null;
          status: string;
          snoozed_until: string | null;
          deleted_at: string | null;
        }
      | undefined;
    try {
      row = db
        .prepare(
          `SELECT t.priority, t.timezone, u.timezone AS user_timezone,
                  ru.timezone AS recipient_timezone,
                  (SELECT ou.timezone FROM users ou
                    WHERE ou.deleted_at IS NULL AND ou.role = 'owner'
                    ORDER BY ou.created_at ASC, ou.id ASC LIMIT 1) AS owner_timezone,
                  t.status, t.snoozed_until, t.deleted_at
             FROM tasks t
             JOIN users u ON u.id = t.user_id
             LEFT JOIN push_subscriptions s
               ON s.id = ? AND s.deleted_at IS NULL
             LEFT JOIN users ru
               ON ru.id = s.user_id AND ru.deleted_at IS NULL
            WHERE t.id = ?`,
        )
        .get(delivery.subscription_id, delivery.task_id) as typeof row;
    } catch {
      row = undefined;
    }

    if (!row || row.deleted_at || row.status !== "open") {
      db.prepare(
        `UPDATE deliveries
         SET status = 'skipped', next_attempt_at = NULL, claim_token = NULL,
             lease_until = NULL, last_error = 'task no longer open',
             updated_at = ?, rev = rev + 1
         WHERE id = ? AND claim_token = ? AND status = 'sending'`,
      ).run(nowIso, delivery.id, delivery.claim_token);
      continue;
    }

    if (row.snoozed_until && Date.parse(row.snoozed_until) > now.getTime()) {
      db.prepare(
        `UPDATE deliveries
         SET status = 'skipped', next_attempt_at = NULL, claim_token = NULL,
             lease_until = NULL, last_error = 'task snoozed',
             updated_at = ?, rev = rev + 1
         WHERE id = ? AND claim_token = ? AND status = 'sending'`,
      ).run(nowIso, delivery.id, delivery.claim_token);
      continue;
    }

    if (
      delivery.channel === "webpush" &&
      deliveryRecipientLostAccess(db, delivery)
    ) {
      db.prepare(
        `UPDATE deliveries
         SET status = 'skipped', next_attempt_at = NULL, claim_token = NULL,
             lease_until = NULL,
             last_error = 'recipient no longer has task access',
             updated_at = ?, rev = rev + 1
         WHERE id = ? AND claim_token = ? AND status = 'sending'`,
      ).run(nowIso, delivery.id, delivery.claim_token);
      continue;
    }

    // Quiet hours are evaluated for the delivery's recipient. `ntfy` has no
    // subscription row and falls back to the workspace owner's zone.
    const timezone =
      delivery.channel === "ntfy" &&
      row.owner_timezone &&
      isValidTimeZone(row.owner_timezone)
        ? row.owner_timezone
        : row.recipient_timezone && isValidTimeZone(row.recipient_timezone)
          ? row.recipient_timezone
          : row.timezone && isValidTimeZone(row.timezone)
            ? row.timezone
            : row.user_timezone && isValidTimeZone(row.user_timezone)
              ? row.user_timezone
              : "UTC";

    if (
      quiet &&
      row.priority < URGENT_PRIORITY &&
      isQuietHoursAt(now, timezone, quiet)
    ) {
      const until = toUtcIso(quietHoursEnd(now, timezone, quiet));
      db.prepare(
        `UPDATE deliveries
         SET status = 'pending', next_attempt_at = ?, claim_token = NULL,
             lease_until = NULL, attempts = MAX(attempts - 1, 0),
             last_error = 'held for quiet hours', updated_at = ?, rev = rev + 1
         WHERE id = ? AND claim_token = ? AND status = 'sending'`,
      ).run(until, nowIso, delivery.id, delivery.claim_token);
      continue;
    }

    out.push(delivery);
  }
  return out;
}

function summarizeResults(
  results: PushDeliveryResult[],
): Pick<TickResult, "sent" | "retried" | "dead" | "skippedDeliveries"> {
  return {
    sent: results.filter((result) => result.status === "sent").length,
    retried: results.filter((result) => result.status === "retry").length,
    dead: results.filter((result) => result.status === "dead").length,
    skippedDeliveries: results.filter(
      (result) => result.status === "skipped" || result.status === "stale",
    ).length,
  };
}

/** One full tick: lease, enqueue, claim, send, ledger activity. */
export async function runSchedulerTick(
  db: BetterDb,
  options: TickOptions = {},
): Promise<TickResult> {
  const emptySkipped = (reason: "lease" | "maintenance"): TickResult => ({
    skipped: reason,
    enqueued: emptyEnqueueResult(),
    claimed: 0,
    sent: 0,
    retried: 0,
    dead: 0,
    skippedDeliveries: 0,
  });
  if (isMaintenanceActive()) return emptySkipped("maintenance");
  // The check and increment happen in one synchronous turn: restore's gate
  // cannot slip between them, so it either sees this tick or this tick sees
  // the gate.
  activeTicks += 1;
  try {
    return await runSchedulerTickInner(db, options, emptySkipped);
  } finally {
    activeTicks = Math.max(0, activeTicks - 1);
    resolveTickWaiters();
  }
}

let activeTicks = 0;
const tickWaiters = new Set<() => void>();

function resolveTickWaiters(): void {
  if (activeTicks !== 0) return;
  for (const resolve of [...tickWaiters]) {
    tickWaiters.delete(resolve);
    resolve();
  }
}

export function schedulerTickActive(): boolean {
  return activeTicks > 0;
}

/** Restore calls this after taking the gate so no tick can touch the handle. */
export async function waitForSchedulerIdle(
  timeoutMs = 30_000,
): Promise<boolean> {
  if (activeTicks === 0) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      tickWaiters.delete(done);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    tickWaiters.add(done);
  });
}

async function runSchedulerTickInner(
  db: BetterDb,
  options: TickOptions,
  emptySkipped: (reason: "lease" | "maintenance") => TickResult,
): Promise<TickResult> {
  const now = resolveNow(options.now);
  const nowIso = asIso(now);
  const owner = options.owner ?? "scheduler";
  const logger = options.logger;

  if (
    !options.skipLease &&
    !acquireSchedulerLease(db, owner, now, options.leaseMs)
  ) {
    return emptySkipped("lease");
  }

  // Bound the CalDAV sync journal under the scheduler lease and maintenance
  // gate. Hysteresis keeps a burst from evicting the whole retained window:
  // prune to 40k only once the 50k cap is crossed.
  try {
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM caldav_changes")
      .get() as { n: number };
    if (n > 50_000) {
      pruneChanges(db, 40_000);
      logger?.info(
        { before: n, retained: 40_000 },
        "pruned the CalDAV change journal",
      );
    }
  } catch (error) {
    logger?.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "CalDAV journal prune failed",
    );
  }

  const batchId = options.batchId ?? newId();
  const enqueued = enqueueDueWork(db, {
    now,
    owner,
    taskLimit: options.taskLimit,
    catchupLimit: options.catchupLimit,
    batchId,
  });

  const claimed = claimDeliveries(db, {
    now,
    limit: options.limit,
    leaseMs: options.leaseMs,
  });

  const quiet = readQuietHours(db);
  const sendable =
    options.send === false
      ? []
      : filterClaimedForSend(db, claimed, now, quiet);

  let results: PushDeliveryResult[] = [];
  if (options.send !== false && sendable.length > 0) {
    results = await sendClaimedDeliveries(db, sendable, {
      now,
      ...options.pushOptions,
    });
  }

  // Delivery ledger activity is written after the network call, in a short
  // transaction. The sender never holds SQLite while talking to a push
  // service. Failure here never changes the delivery outcome.
  if (results.length > 0) {
    const rows: ActivityEventRow[] = [];
    try {
      const record = db.transaction(() => {
        for (const result of results) {
          const action =
            result.status === "sent"
              ? "delivery.sent"
              : result.status === "dead"
                ? "delivery.dead"
                : result.status === "retry"
                  ? "delivery.retry"
                  : "delivery.skipped";
          const info = db
            .prepare(
              `INSERT INTO activity
                 (batch_id, actor, action, entity_type, entity_id, before_json, after_json, summary, created_at)
               VALUES (?, 'scheduler', ?, 'delivery', ?, NULL, ?, ?, ?)`,
            )
            .run(
              batchId,
              action,
              result.id,
              JSON.stringify({
                status: result.status,
                statusCode: result.statusCode ?? null,
                error: result.error ?? null,
              }),
              result.error
                ? `Delivery ${result.id}: ${result.status} (${result.error})`
                : `Delivery ${result.id}: ${result.status}`,
              nowIso,
            );
          rows.push({
            seq: Number(info.lastInsertRowid),
            batch_id: batchId,
            actor: "scheduler",
            action,
            entity_type: "delivery",
            entity_id: result.id,
            before_json: null,
            after_json: JSON.stringify({
              status: result.status,
              statusCode: result.statusCode ?? null,
              error: result.error ?? null,
            }),
            summary: result.error
              ? `Delivery ${result.id}: ${result.status} (${result.error})`
              : `Delivery ${result.id}: ${result.status}`,
            created_at: nowIso,
          });
        }
      });
      record.immediate();
      publishActivity(rows);
    } catch (error) {
      logger?.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "could not write delivery activity",
      );
    }
  }

  const counts = summarizeResults(results);
  if (options.nightlyBackup) {
    try {
      await maybeRunNightlyBackup(db, now, {
        hours: options.nightlyBackupHours ?? 24,
        logger,
      });
    } catch (error) {
      logger?.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "nightly backup failed",
      );
    }
  }
  maybeRunRetention(
    db,
    now,
    options.activityRetentionDays ?? 90,
    logger,
  );
  // Briefs are user-level notifications and share the scheduler lease.
  // Tests and `send:false` calls do not touch the network.
  if (options.send !== false && options.digests !== false) {
    try {
      await maybeSendDigests(db, now, { ...options.pushOptions, now });
    } catch (error) {
      logger?.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "digest send failed",
      );
    }
  }
  return {
    enqueued,
    claimed: claimed.length,
    ...counts,
  };
}

let lastRetentionAt = 0;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Daily operational retention. Activity is the fastest-growing table; the
 * other logs (deliveries, operations, agent messages, proposals, sessions)
 * are bounded too. Core reminder data is never pruned.
 */
function maybeRunRetention(
  db: BetterDb,
  now: Date,
  activityRetentionDays: number,
  logger?: SchedulerLogger,
): void {
  if (!Number.isFinite(activityRetentionDays)) return;
  if (now.getTime() - lastRetentionAt < RETENTION_INTERVAL_MS) return;
  lastRetentionAt = now.getTime();
  try {
    const counts = runRetention(db, { now, activityRetentionDays });
    const total = Object.values(counts).reduce(
      (sum, count) => sum + count,
      0,
    );
    if (total > 0) {
      logger?.info({ counts }, "pruned old operational rows");
    }
  } catch (error) {
    logger?.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "operational retention failed",
    );
  }
}

/**
 * App-scheduled nightly JSON backup (supported path §6). Runs under the
 * scheduler lease so only one process backs up. Skips when a nightly run
 * exists within `hours`. Failures are logged by the caller and never fail
 * the reminder tick. The volume-level `deploy/backup-cron.sh` remains only
 * as a secondary SQLite snapshot (stopgap).
 */
async function maybeRunNightlyBackup(
  db: BetterDb,
  now: Date,
  opts: { hours: number; logger?: SchedulerLogger },
): Promise<void> {
  let last: string | null = null;
  try {
    const row = db
      .prepare(
        `SELECT created_at FROM backup_runs WHERE status = 'nightly'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { created_at: string } | undefined;
    last = row?.created_at ?? null;
  } catch {
    return;
  }
  if (last) {
    const ageMs = now.getTime() - Date.parse(last);
    if (Number.isFinite(ageMs) && ageMs < opts.hours * 3_600_000) {
      return;
    }
  }
  // Lazy import keeps the scheduler testable without pulling backup I/O
  // into every tick; the module has no scheduler dependency.
  const { runBackupNow } = await import("./backup.js");
  const { run } = await runBackupNow(db as never, { status: "nightly" });
  opts.logger?.info(
    { backupId: run.id, bytes: run.bytes },
    "nightly backup completed",
  );
}

export interface StartSchedulerOptions extends TickOptions {
  intervalMs?: number;
  tickOnStart?: boolean;
}

let active: SchedulerHandle | null = null;
let lastStartOptions: StartSchedulerOptions | null = null;

/** Start the single scheduler loop. Safe to call once per process. */
export function startScheduler(
  db: BetterDb,
  options: StartSchedulerOptions = {},
): SchedulerHandle {
  if (active) return active;
  lastStartOptions = { ...options };

  const intervalMs = Math.max(1_000, options.intervalMs ?? SCHEDULER_TICK_MS);
  const owner = options.owner ?? `scheduler:${process.pid}:${newId()}`;
  let running = false;
  let stopped = false;

  const tick = async (): Promise<TickResult> => {
    if (stopped) {
      return {
        skipped: "lease",
        enqueued: emptyEnqueueResult(),
        claimed: 0,
        sent: 0,
        retried: 0,
        dead: 0,
        skippedDeliveries: 0,
      };
    }
    if (running) {
      return {
        skipped: "lease",
        enqueued: emptyEnqueueResult(),
        claimed: 0,
        sent: 0,
        retried: 0,
        dead: 0,
        skippedDeliveries: 0,
      };
    }
    running = true;
    try {
      const result = await runSchedulerTick(db, { ...options, owner });
      if (result.enqueued.deliveriesInserted > 0 || result.claimed > 0) {
        options.logger?.info(
          {
            deliveries: result.enqueued.deliveriesInserted,
            missed: result.enqueued.missedInserted,
            claimed: result.claimed,
            sent: result.sent,
            retried: result.retried,
            dead: result.dead,
          },
          "scheduler tick",
        );
      }
      return result;
    } catch (error) {
      options.logger?.error(
        { err: error instanceof Error ? error.message : String(error) },
        "scheduler tick failed",
      );
      return {
        enqueued: emptyEnqueueResult(),
        claimed: 0,
        sent: 0,
        retried: 0,
        dead: 0,
        skippedDeliveries: 0,
      };
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  active = {
    owner,
    tick,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      releaseSchedulerLease(db, owner);
      if (active?.owner === owner) active = null;
    },
  };

  if (options.tickOnStart !== false) {
    void tick();
  }
  return active;
}

export function getActiveScheduler(): SchedulerHandle | null {
  return active;
}

/** Stop the process-wide scheduler (test hook and graceful shutdown). */
export function stopScheduler(): void {
  active?.stop();
  active = null;
}

/**
 * Rebuild the scheduler after a live restore reopened the DB singleton.
 * `startScheduler` captured the old handle; this restart binds the new one.
 * No-op when the scheduler was never started (tests / API-only builds).
 */
export function restartSchedulerAfterRestore(): boolean {
  const options = lastStartOptions;
  if (!options) return false;
  stopScheduler();
  startScheduler(getDb(), options);
  return true;
}

// ---------------------------------------------------------------------------
// Ledger one-liner (§4)
// ---------------------------------------------------------------------------

export interface DeliveryLedger {
  nextAt: string | null;
  deviceCount: number;
  lastSentAt: string | null;
  state: "armed" | "waiting" | "degraded" | "off";
  line: string;
}

/**
 * One-line delivery ledger used by Task detail:
 * "Next Fri 9:00 · 2 devices · Last sent 2h ago".
 *
 * The caller formats `nextAt`/`lastSentAt` in the user's zone; this helper is
 * deliberately locale-free so the same line can be produced server-side.
 */
export function deliveryLedger(
  db: BetterDb,
  taskId: string,
): DeliveryLedger {
  let nextAt: string | null = null;
  let deviceCount = 0;
  let lastSentAt: string | null = null;
  try {
    const task = db
      .prepare(
        `SELECT next_occurrence_at, remind_at FROM tasks WHERE id = ?`,
      )
      .get(taskId) as
      | { next_occurrence_at: string | null; remind_at: string | null }
      | undefined;
    nextAt = task?.next_occurrence_at ?? task?.remind_at ?? null;
    const devices = db
      .prepare(
        `SELECT COUNT(*) AS n FROM push_subscriptions
         WHERE enabled = 1 AND deleted_at IS NULL`,
      )
      .get() as { n: number };
    deviceCount = devices?.n ?? 0;
    const sent = db
      .prepare(
        `SELECT sent_at FROM deliveries
         WHERE task_id = ? AND status = 'sent' AND sent_at IS NOT NULL
         ORDER BY sent_at DESC LIMIT 1`,
      )
      .get(taskId) as { sent_at: string } | undefined;
    lastSentAt = sent?.sent_at ?? null;
    const failed = db
      .prepare(
        `SELECT COUNT(*) AS n FROM deliveries
         WHERE task_id = ? AND status = 'dead'`,
      )
      .get(taskId) as { n: number };
    const state: DeliveryLedger["state"] =
      (failed?.n ?? 0) > 0
        ? "degraded"
        : deviceCount === 0
          ? "off"
          : nextAt
            ? "armed"
            : "waiting";
    return {
      nextAt,
      deviceCount,
      lastSentAt,
      state,
      line: [
        nextAt ? `Next ${nextAt}` : "No next reminder",
        `${deviceCount} ${deviceCount === 1 ? "device" : "devices"}`,
        lastSentAt ? `Last sent ${lastSentAt}` : "Nothing sent yet",
      ].join(" · "),
    };
  } catch {
    return {
      nextAt,
      deviceCount,
      lastSentAt,
      state: "off",
      line: "No next reminder · 0 devices · Nothing sent yet",
    };
  }
}
