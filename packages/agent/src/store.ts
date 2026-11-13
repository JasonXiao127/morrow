/**
 * Narrow SQLite store used by the shim.
 *
 * It intentionally does not replace the M1 task service: MCP tools need a
 * transactional boundary that works even when the app is deployed with only
 * the deterministic core. The column names follow §3 and every write is
 * recorded in `activity` with a before/after snapshot so it can be undone.
 */
import type { BetterDb } from "@morrow/db";
import {
  deriveReminder,
  initialSortKey,
  newId,
  normalizeWallTime,
  nowIso,
  resolveWallTime,
  sortKeyAfter,
  wallDateInZone,
  startOfWallDate,
  endOfWallDateExclusive,
  nextOccurrenceForMode,
  generateOccurrences,
  type RecurrenceInput,
} from "@morrow/shared";
import {
  AgentError,
  type AssistantMessageRecord,
  type ConversationRecord,
  type ProposalOperation,
  type ProposalRecord,
  type TaskCreateInput,
  type TaskListRecord,
  type TaskUpdateInput,
  type TaskView,
} from "./types.js";
import {
  hashPayload,
  toTaskView,
} from "./util.js";

interface UserRow {
  id: string;
  username: string;
  timezone: string;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  title: string;
  rev: number;
}

interface ListRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  name: string;
  rev: number;
}

export interface TaskFilters {
  status?: "open" | "done" | "cancelled" | "all";
  view?: "today" | "upcoming" | "inbox" | "all";
  listId?: string | null;
  query?: string;
  limit?: number;
  today?: string;
  todayStart?: string;
  todayEnd?: string;
}

export interface ActivityWrite {
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  summary: string;
  batchId?: string | null;
  opId?: string | null;
}

const TASK_COLUMNS: Record<keyof TaskCreateInput, string> = {
  id: "id",
  title: "title",
  notes: "notes",
  listId: "list_id",
  priority: "priority",
  dueAt: "due_at",
  dueDate: "due_date",
  allDay: "all_day",
  timezone: "timezone",
  remindAt: "remind_at",
  reminderTimeLocal: "reminder_time_local",
  remindOffsetMinutes: "remind_offset_minutes",
  rrule: "rrule",
  dtstartLocal: "dtstart_local",
  recurrenceUntilUtc: "recurrence_until_utc",
  recurrenceUntilDate: "recurrence_until_date",
  recurrenceCount: "recurrence_count",
  wkst: "wkst",
  recurrenceMode: "recurrence_mode",
  clampPolicy: "clamp_policy",
};

const UPDATE_COLUMN_MAP: Record<keyof TaskUpdateInput, string> = {
  title: "title",
  notes: "notes",
  listId: "list_id",
  priority: "priority",
  status: "status",
  dueAt: "due_at",
  dueDate: "due_date",
  allDay: "all_day",
  timezone: "timezone",
  remindAt: "remind_at",
  reminderTimeLocal: "reminder_time_local",
  remindOffsetMinutes: "remind_offset_minutes",
  snoozedUntil: "snoozed_until",
  rrule: "rrule",
  dtstartLocal: "dtstart_local",
  nextOccurrenceAt: "next_occurrence_at",
  nextOccurrenceLocal: "next_occurrence_local",
  occurrenceSeq: "occurrence_seq",
  recurrenceUntilUtc: "recurrence_until_utc",
  recurrenceUntilDate: "recurrence_until_date",
  recurrenceCount: "recurrence_count",
  wkst: "wkst",
  recurrenceMode: "recurrence_mode",
  clampPolicy: "clamp_policy",
  seriesEndedAt: "series_ended_at",
  missedCount: "missed_count",
  completedAt: "completed_at",
  sortKey: "sort_key",
};

/**
 * Exact writable columns for an undo restore (mirrors the tasks table except
 * the identity/revision/clock columns, which undo owns). Snapshots are
 * attacker-influenced data (they can arrive through sync/restore), so unknown
 * keys fail closed instead of becoming SQL identifiers.
 */
const TASK_UNDO_WRITABLE_COLUMNS = new Set([
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
]);

const SAFE_COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Present in full row snapshots but never restored from them: identity,
 * ownership and clock columns. Undo keeps the live identity and bumps rev /
 * updated_at itself.
 */
const TASK_PROTECTED_UNDO_COLUMNS = new Set([
  "id",
  "user_id",
  "rev",
  "created_at",
  "updated_at",
]);

function bool(value: boolean | undefined): number {
  return value ? 1 : 0;
}

/**
 * The assistant and MCP surfaces are owner-only. Resolve the explicit owner
 * rather than whichever account happened to be created first. A legacy
 * single-user database with no role backfill is still accepted because there
 * is only one possible identity; multi-user ambiguity fails closed.
 */
export function ownerUserId(db: BetterDb): string | null {
  try {
    const owner = db
      .prepare(
        "SELECT id FROM users WHERE deleted_at IS NULL AND role = 'owner' ORDER BY created_at ASC, id ASC LIMIT 1",
      )
      .get() as { id: string } | undefined;
    if (owner) return owner.id;
    const rows = db
      .prepare(
        "SELECT id FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 2",
      )
      .all() as Array<{ id: string }>;
    return rows.length === 1 ? (rows[0]?.id ?? null) : null;
  } catch {
    return null;
  }
}

export class TaskStore {
  readonly db: BetterDb;
  private readonly userId: string | undefined;

  constructor(db: BetterDb, userId?: string) {
    this.db = db;
    this.userId = userId;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getUser(): UserRow {
    const row = this.userId
      ? (this.db
          .prepare(
            "SELECT id, username, timezone FROM users WHERE id = ? AND deleted_at IS NULL",
          )
          .get(this.userId) as UserRow | undefined)
      : (() => {
          const id = ownerUserId(this.db);
          return id
            ? (this.db
                .prepare(
                  "SELECT id, username, timezone FROM users WHERE id = ? AND deleted_at IS NULL",
                )
                .get(id) as UserRow | undefined)
            : undefined;
        })();
    if (!row) {
      throw new AgentError(
        "not_setup",
        "Morrow has no unambiguous owner account. Complete setup before using the assistant.",
        409,
      );
    }
    return row;
  }

  /**
   * Task visibility follows the same rule as the REST surface: the creator,
   * the list owner, or an explicit list member. A task with no list is
   * private to its creator. Callers pass the viewer id three times because
   * the SQL predicate references the same id in three places.
   */
  private accessClause(alias = "t"): { sql: string; args: string[] } {
    const userId = this.getUser().id;
    return {
      sql: `(${alias}.user_id = ? OR (${alias}.list_id IS NOT NULL AND (EXISTS (SELECT 1 FROM lists l WHERE l.id = ${alias}.list_id AND l.user_id = ?) OR EXISTS (SELECT 1 FROM list_members lm WHERE lm.list_id = ${alias}.list_id AND lm.user_id = ?))))`,
      args: [userId, userId, userId],
    };
  }

  private taskIdExists(id: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM tasks WHERE id = ? LIMIT 1")
      .get(id) as { ok: number } | undefined;
    return Boolean(row);
  }

  getSetting(key: string): unknown {
    try {
      const row = this.db
        .prepare("SELECT value FROM settings WHERE key = ? AND deleted_at IS NULL")
        .get(key) as { value: string } | undefined;
      if (!row) return undefined;
      try {
        return JSON.parse(row.value);
      } catch {
        return row.value;
      }
    } catch {
      return undefined;
    }
  }

  setSetting(key: string, value: unknown): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO settings (key, value, rev, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
           rev = settings.rev + 1, updated_at = excluded.updated_at, deleted_at = NULL`,
      )
      .run(key, JSON.stringify(value), now);
  }

  timezone(): string {
    const user = this.getUser();
    // The account timezone is the source of truth for this owner's reminders.
    // `settings.timezone` is a workspace default used when seeding accounts.
    if (user.timezone && user.timezone.trim()) return user.timezone;
    const configured = this.getSetting("timezone");
    return typeof configured === "string" && configured.trim()
      ? configured
      : "UTC";
  }

  currentMaxRev(): number {
    const lists = this.db
      .prepare("SELECT MAX(rev) AS m FROM lists WHERE deleted_at IS NULL")
      .get() as { m: number | null };
    const tasks = this.db
      .prepare("SELECT MAX(rev) AS m FROM tasks WHERE deleted_at IS NULL")
      .get() as { m: number | null };
    return Math.max(lists.m ?? 0, tasks.m ?? 0, 0);
  }

  listLists(): TaskListRecord[] {
    const userId = this.getUser().id;
    const rows = this.db
      .prepare(
        `SELECT l.* FROM lists l
          WHERE l.deleted_at IS NULL
            AND (l.user_id = ? OR EXISTS (
              SELECT 1 FROM list_members lm
               WHERE lm.list_id = l.id AND lm.user_id = ?
            ))
          ORDER BY CASE WHEN l.user_id = ? THEN 0 ELSE 1 END,
                   l.sort_key ASC, l.created_at ASC`,
      )
      .all(userId, userId, userId) as ListRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      color: (row["color"] as string | null) ?? null,
      isInbox: row["is_inbox"] === 1 || row["is_inbox"] === true,
      rev: Number(row.rev),
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
    }));
  }

  getList(id: string | null | undefined): ListRow | null {
    if (!id) return null;
    const userId = this.getUser().id;
    const row = this.db
      .prepare(
        `SELECT l.* FROM lists l
          WHERE l.id = ? AND l.deleted_at IS NULL
            AND (l.user_id = ? OR EXISTS (
              SELECT 1 FROM list_members lm
               WHERE lm.list_id = l.id AND lm.user_id = ?
            ))`,
      )
      .get(id, userId, userId) as ListRow | undefined;
    return row ?? null;
  }

  listTasks(filters: TaskFilters = {}): TaskView[] {
    const access = this.accessClause("t");
    const where: string[] = [access.sql, "t.deleted_at IS NULL"];
    const args: unknown[] = [...access.args];
    const status = filters.status ?? "open";
    if (status !== "all") {
      where.push("t.status = ?");
      args.push(status);
    }
    if (filters.listId !== undefined) {
      if (filters.listId === null) where.push("t.list_id IS NULL");
      else {
        where.push("t.list_id = ?");
        args.push(filters.listId);
      }
    }
    if (filters.query) {
      where.push("(t.title LIKE ? OR COALESCE(t.notes, '') LIKE ?)");
      const like = `%${filters.query.replace(/[%_]/g, "\\$&")}%`;
      args.push(like, like);
    }
    const today = filters.today;
    if (filters.view === "today" && today) {
      if (filters.todayStart && filters.todayEnd) {
        where.push(
          "((t.due_date IS NOT NULL AND t.due_date <= ?) OR (COALESCE(t.next_occurrence_at, t.due_at) IS NOT NULL AND COALESCE(t.next_occurrence_at, t.due_at) < ?))",
        );
        args.push(today, filters.todayEnd);
      } else {
        where.push(
          "((t.due_date IS NOT NULL AND t.due_date <= ?) OR (t.due_at IS NOT NULL AND date(t.due_at) <= ?))",
        );
        args.push(today, today);
      }
    } else if (filters.view === "upcoming" && today) {
      if (filters.todayEnd) {
        where.push(
          "((t.due_date IS NOT NULL AND t.due_date > ?) OR (COALESCE(t.next_occurrence_at, t.due_at) IS NOT NULL AND COALESCE(t.next_occurrence_at, t.due_at) >= ?))",
        );
        args.push(today, filters.todayEnd);
      } else {
        where.push(
          "((t.due_date IS NOT NULL AND t.due_date > ?) OR (t.due_at IS NOT NULL AND date(t.due_at) > ?))",
        );
        args.push(today, today);
      }
    } else if (filters.view === "inbox") {
      where.push("(t.list_id IS NULL OR t.list_id IN (SELECT id FROM lists WHERE is_inbox = 1 AND deleted_at IS NULL))");
    }
    const limit = Math.max(1, Math.min(200, filters.limit ?? 50));
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t WHERE ${where.join(" AND ")}
         ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at ASC,
                  t.due_date ASC, t.created_at ASC LIMIT ?`,
      )
      .all(...args, limit) as TaskRow[];
    return rows.map(toTaskView);
  }

  getTask(id: string): TaskView | null {
    const access = this.accessClause("t");
    const row = this.db
      .prepare(
        `SELECT t.* FROM tasks t
          WHERE t.id = ? AND t.deleted_at IS NULL AND ${access.sql}`,
      )
      .get(id, ...access.args) as TaskRow | undefined;
    return row ? toTaskView(row) : null;
  }

  getTaskRow(id: string): TaskRow | null {
    const access = this.accessClause("t");
    const row = this.db
      .prepare(`SELECT t.* FROM tasks t WHERE t.id = ? AND ${access.sql}`)
      .get(id, ...access.args) as TaskRow | undefined;
    return row ?? null;
  }

  getTasksByIds(ids: string[]): TaskView[] {
    if (ids.length === 0) return [];
    const access = this.accessClause("t");
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t
          WHERE t.id IN (${placeholders}) AND t.deleted_at IS NULL AND ${access.sql}`,
      )
      .all(...ids, ...access.args) as TaskRow[];
    return rows.map(toTaskView);
  }

  searchTasks(query: string, limit = 50): TaskView[] {
    return this.listTasks({ query, status: "all", limit });
  }

  tasksForDay(date: string, timezone = this.timezone()): TaskView[] {
    const access = this.accessClause("t");
    let start: string;
    let end: string;
    try {
      start = startOfWallDate(date, timezone).instantIso;
      end = endOfWallDateExclusive(date, timezone).instantIso;
    } catch {
      start = `${date}T00:00:00.000Z`;
      end = `${date}T23:59:59.999Z`;
    }
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t
          WHERE ${access.sql} AND t.deleted_at IS NULL AND t.status = 'open'
            AND ((t.all_day = 1 AND t.due_date = ?)
              OR (t.all_day = 0 AND COALESCE(t.next_occurrence_at, t.due_at) >= ?
                  AND COALESCE(t.next_occurrence_at, t.due_at) < ?))
          ORDER BY COALESCE(t.next_occurrence_at, t.due_at) ASC, t.created_at ASC LIMIT 200`,
      )
      .all(...access.args, date, start, end) as TaskRow[];
    return rows.map(toTaskView);
  }

  nextSortKey(): string {
    const access = this.accessClause("t");
    const row = this.db
      .prepare(
        `SELECT MAX(t.sort_key) AS k FROM tasks t
          WHERE ${access.sql} AND t.deleted_at IS NULL`,
      )
      .get(...access.args) as { k: string | null };
    if (!row?.k) return initialSortKey();
    return sortKeyAfter(row.k);
  }

  createTask(input: TaskCreateInput): TaskView {
    const userId = this.getUser().id;
    const id = input.id ?? newId();
    if (this.taskIdExists(id)) {
      throw new AgentError("duplicate_id", `Task ${id} already exists.`, 409);
    }
    if (input.listId && !this.getList(input.listId)) {
      throw new AgentError("unknown_list", "The target list does not exist.", 400);
    }
    this.validateTaskFields({
      allDay: input.allDay ?? false,
      dueAt: input.dueAt ?? null,
      dueDate: input.dueDate ?? null,
      rrule: input.rrule ?? null,
      dtstartLocal: input.dtstartLocal ?? null,
    });
    const now = nowIso();
    const allDay = input.allDay ?? false;
    const userTz = this.timezone();
    const taskTz = input.timezone ?? null;
    const derived = deriveReminder({
      dueAt: input.dueAt ?? null,
      dueDate: input.dueDate ?? null,
      allDay,
      timezone: taskTz,
      fallbackTimezone: userTz,
      reminderTimeLocal: input.reminderTimeLocal ?? null,
      remindOffsetMinutes: input.remindOffsetMinutes ?? null,
      explicitRemindAt:
        Object.prototype.hasOwnProperty.call(input, "remindAt")
          ? (input.remindAt ?? null)
          : undefined,
      rrule: input.rrule ?? null,
      dtstartLocal: input.dtstartLocal ?? null,
      recurrenceCount: input.recurrenceCount ?? null,
      recurrenceUntilUtc: input.recurrenceUntilUtc ?? null,
      recurrenceUntilDate: input.recurrenceUntilDate ?? null,
      wkst: input.wkst ?? null,
      recurrenceMode: input.recurrenceMode ?? null,
      clampPolicy: input.clampPolicy ?? null,
    });
    const values: Record<string, unknown> = {
      id,
      user_id: userId,
      list_id: input.listId ?? null,
      title: input.title,
      notes: input.notes ?? null,
      // Match the REST/CalDAV fallback identity explicitly so uniqueness is
      // enforced at insert time rather than only in the serializer.
      ical_uid: `${id}@morrow`,
      caldav_href: `${id}.ics`,
      status: "open",
      priority: input.priority ?? 0,
      due_at: input.dueAt ?? null,
      due_date: input.dueDate ?? null,
      all_day: bool(allDay),
      timezone: taskTz,
      remind_at: Object.prototype.hasOwnProperty.call(input, "remindAt")
        ? (input.remindAt ?? null)
        : derived.remindAt,
      reminder_time_local: input.reminderTimeLocal ?? null,
      remind_offset_minutes: input.remindOffsetMinutes ?? null,
      snoozed_until: null,
      dtstart_local: input.dtstartLocal ?? null,
      next_occurrence_at: derived.nextOccurrenceAt,
      next_occurrence_local: derived.nextOccurrenceLocal,
      occurrence_seq: derived.occurrenceSeq,
      rrule: input.rrule ?? null,
      recurrence_until_utc: input.recurrenceUntilUtc ?? null,
      recurrence_until_date: input.recurrenceUntilDate ?? null,
      recurrence_count: input.recurrenceCount ?? null,
      wkst: input.wkst ?? null,
      recurrence_mode: input.recurrenceMode ?? "schedule",
      clamp_policy: input.clampPolicy ?? "skip",
      series_ended_at: null,
      missed_count: 0,
      completed_at: null,
      sort_key: this.nextSortKey(),
      created_by: "agent",
      updated_by: "agent",
      rev: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    if (values["rrule"] && values["dtstart_local"] && !derived.nextOccurrenceAt && !derived.nextOccurrenceLocal) {
      // deriveReminder found no valid first occurrence; keep the explicit
      // validation error path instead of persisting an armless series.
      const first = this.firstOccurrenceFromValues(
        values,
        input.timezone ?? this.timezone(),
      );
      if (!first) {
        throw new AgentError(
          "invalid_recurrence",
          "That recurrence could not be parsed. Check the rule and start date.",
          400,
        );
      }
      values["next_occurrence_at"] = first.nextAt;
      values["next_occurrence_local"] = first.nextLocal;
      values["occurrence_seq"] = first.seq;
    }
    const columns = Object.keys(values);
    this.db
      .prepare(
        `INSERT INTO tasks (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      )
      .run(...columns.map((column) => values[column]));
    const row = this.getTaskRow(id);
    if (!row) throw new AgentError("write_failed", "Task was not persisted.", 500);
    return toTaskView(row);
  }

  updateTask(
    id: string,
    patch: TaskUpdateInput,
    expectedRev?: number,
  ): { before: TaskView; after: TaskView } {
    const row = this.getTaskRow(id);
    if (!row || row["deleted_at"] != null) {
      throw new AgentError("not_found", `Task ${id} was not found.`, 404);
    }
    if (expectedRev !== undefined && Number(row.rev) !== expectedRev) {
      throw new AgentError(
        "stale_revision",
        `Task ${id} changed (rev ${row.rev}, expected ${expectedRev}). Re-read it and try again.`,
        412,
      );
    }
    if (patch.listId && !this.getList(patch.listId)) {
      throw new AgentError("unknown_list", "The target list does not exist.", 400);
    }
    this.validateTaskFields({
      allDay:
        patch.allDay !== undefined
          ? patch.allDay
          : row["all_day"] === 1 || row["all_day"] === true,
      dueAt:
        patch.dueAt !== undefined ? patch.dueAt : (row["due_at"] as string | null),
      dueDate:
        patch.dueDate !== undefined
          ? patch.dueDate
          : (row["due_date"] as string | null),
      rrule:
        patch.rrule !== undefined
          ? patch.rrule
          : (row["rrule"] as string | null),
      dtstartLocal:
        patch.dtstartLocal !== undefined
          ? patch.dtstartLocal
          : (row["dtstart_local"] as string | null),
    });
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [key, column] of Object.entries(UPDATE_COLUMN_MAP) as Array<
      [keyof TaskUpdateInput, string]
    >) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      // Reminder + occurrence fields are recomputed below; skip them here so
      // a stale explicit value cannot survive a reschedule.
      if (
        key === "remindAt" ||
        key === "nextOccurrenceAt" ||
        key === "nextOccurrenceLocal"
      ) {
        continue;
      }
      const value = patch[key];
      sets.push(`${column} = ?`);
      args.push(key === "allDay" ? bool(value as boolean) : value ?? null);
    }
    // Always bump rev even when only reminder fields change.
    const now = nowIso();
    sets.push("rev = rev + 1", "updated_at = ?", "updated_by = 'agent'");
    args.push(now, id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args);

    // Recompute armed reminders when the schedule changes. Explicit remindAt
    // (including null) wins; otherwise due instant + offset. Timezone changes
    // re-resolve; past completion keys stay untouched.
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
    if (scheduleTouched) {
      const current = this.getTaskRow(id);
      if (current) {
        const mergedAllDay =
          patch.allDay !== undefined
            ? Boolean(patch.allDay)
            : current["all_day"] === 1 || current["all_day"] === true;
        const derived = deriveReminder({
          dueAt:
            patch.dueAt !== undefined
              ? patch.dueAt
              : (current["due_at"] as string | null),
          dueDate:
            patch.dueDate !== undefined
              ? patch.dueDate
              : (current["due_date"] as string | null),
          allDay: mergedAllDay,
          timezone:
            patch.timezone !== undefined
              ? patch.timezone
              : (current["timezone"] as string | null),
          fallbackTimezone: this.timezone(),
          reminderTimeLocal:
            patch.reminderTimeLocal !== undefined
              ? patch.reminderTimeLocal
              : (current["reminder_time_local"] as string | null),
          remindOffsetMinutes:
            patch.remindOffsetMinutes !== undefined
              ? patch.remindOffsetMinutes
              : (current["remind_offset_minutes"] as number | null),
          explicitRemindAt: Object.prototype.hasOwnProperty.call(patch, "remindAt")
            ? (patch.remindAt ?? null)
            : undefined,
          rrule:
            patch.rrule !== undefined
              ? patch.rrule
              : (current["rrule"] as string | null),
          dtstartLocal:
            patch.dtstartLocal !== undefined
              ? patch.dtstartLocal
              : (current["dtstart_local"] as string | null),
          recurrenceCount:
            patch.recurrenceCount !== undefined
              ? patch.recurrenceCount
              : (current["recurrence_count"] as number | null),
          recurrenceUntilUtc:
            patch.recurrenceUntilUtc !== undefined
              ? patch.recurrenceUntilUtc
              : (current["recurrence_until_utc"] as string | null),
          recurrenceUntilDate:
            patch.recurrenceUntilDate !== undefined
              ? patch.recurrenceUntilDate
              : (current["recurrence_until_date"] as string | null),
          wkst:
            patch.wkst !== undefined
              ? patch.wkst
              : (current["wkst"] as string | null),
          recurrenceMode:
            patch.recurrenceMode !== undefined
              ? patch.recurrenceMode
              : (current["recurrence_mode"] as string | null),
          clampPolicy:
            patch.clampPolicy !== undefined
              ? patch.clampPolicy
              : (current["clamp_policy"] as string | null),
        });
        const hasExplicitNext =
          Object.prototype.hasOwnProperty.call(patch, "nextOccurrenceAt") ||
          Object.prototype.hasOwnProperty.call(patch, "nextOccurrenceLocal");
        const finalRemind = Object.prototype.hasOwnProperty.call(patch, "remindAt")
          ? (patch.remindAt ?? null)
          : derived.remindAt;
        let finalNextAt = derived.nextOccurrenceAt;
        let finalNextLocal = derived.nextOccurrenceLocal;
        let finalSeq = derived.occurrenceSeq;
        if (hasExplicitNext) {
          finalNextAt =
            patch.nextOccurrenceAt !== undefined
              ? patch.nextOccurrenceAt
              : (current["next_occurrence_at"] as string | null);
          finalNextLocal =
            patch.nextOccurrenceLocal !== undefined
              ? patch.nextOccurrenceLocal
              : (current["next_occurrence_local"] as string | null);
          finalSeq = Number(current["occurrence_seq"] ?? 0);
        } else if (
          !(patch.rrule !== undefined
            ? patch.rrule
            : (current["rrule"] as string | null))
        ) {
          finalNextAt = null;
          finalNextLocal = null;
          finalSeq = 0;
        }
        this.db
          .prepare(
            `UPDATE tasks SET remind_at = ?, next_occurrence_at = ?, next_occurrence_local = ?, occurrence_seq = ?, updated_at = ? WHERE id = ?`,
          )
          .run(finalRemind, finalNextAt, finalNextLocal, finalSeq, nowIso(), id);
      }
    }
    this.cancelPendingDeliveries(id);
    const after = this.getTaskRow(id);
    if (!after) throw new AgentError("write_failed", "Task was not persisted.", 500);
    return { before: toTaskView(row), after: toTaskView(after) };
  }

  completeTask(
    id: string,
    occurrenceKey?: string,
    expectedRev?: number,
  ): { before: TaskView; after: TaskView; completion: Record<string, unknown> | null } {
    const row = this.getTaskRow(id);
    this.assertWritable(row, id, expectedRev);
    const now = nowIso();
    const key = this.occurrenceKeyFor(row!, occurrenceKey, now);
    const completion = this.insertCompletion(id, key, "completed", now);
    this.cancelPendingDeliveries(id);
    this.advanceRecurrence(row!, key, now, "complete");
    const after = this.getTaskRow(id);
    if (!after) throw new AgentError("write_failed", "Task was not persisted.", 500);
    return { before: toTaskView(row!), after: toTaskView(after), completion };
  }

  snoozeTask(
    id: string,
    until: string,
    expectedRev?: number,
  ): { before: TaskView; after: TaskView } {
    const result = this.updateTask(id, { snoozedUntil: until }, expectedRev);
    this.cancelPendingDeliveries(id);
    return result;
  }

  skipTask(
    id: string,
    occurrenceKey?: string,
    expectedRev?: number,
  ): { before: TaskView; after: TaskView; completion: Record<string, unknown> | null } {
    const row = this.getTaskRow(id);
    this.assertWritable(row, id, expectedRev);
    const now = nowIso();
    const key = this.occurrenceKeyFor(row!, occurrenceKey, now);
    const completion = this.insertCompletion(id, key, "skipped", now);
    this.cancelPendingDeliveries(id);
    this.advanceRecurrence(row!, key, now, "skip");
    const after = this.getTaskRow(id);
    if (!after) throw new AgentError("write_failed", "Task was not persisted.", 500);
    return { before: toTaskView(row!), after: toTaskView(after), completion };
  }

  private validateTaskFields(input: {
    allDay: boolean;
    dueAt: string | null;
    dueDate: string | null;
    rrule: string | null;
    dtstartLocal: string | null;
  }): void {
    if (input.allDay && input.dueAt != null && input.dueDate == null) {
      throw new AgentError(
        "invalid_task",
        "All-day tasks require dueDate; do not use a UTC-midnight dueAt.",
        400,
      );
    }
    if (input.rrule != null && input.dtstartLocal == null) {
      throw new AgentError(
        "invalid_recurrence",
        "A recurring task needs dtstartLocal.",
        400,
      );
    }
  }

  private timezoneFor(row: Record<string, unknown>): string {
    return String(row["timezone"] ?? this.timezone());
  }

  private firstOccurrenceFromValues(
    values: Record<string, unknown>,
    timezone: string,
  ): { nextAt: string | null; nextLocal: string; seq: number } | null {
    const input: RecurrenceInput = {
      rrule: String(values["rrule"]),
      dtstartLocal: String(values["dtstart_local"]),
      timezone,
      count:
        values["recurrence_count"] == null
          ? null
          : Number(values["recurrence_count"]),
      untilUtc: (values["recurrence_until_utc"] as string | null) ?? null,
      untilDate: (values["recurrence_until_date"] as string | null) ?? null,
      wkst: (values["wkst"] as string | null) ?? null,
      clampPolicy: values["clamp_policy"] === "last-day" ? "last-day" : "skip",
      allDay: values["all_day"] === 1 || values["all_day"] === true,
      reminderTimeLocal:
        (values["reminder_time_local"] as string | null) ?? null,
    };
    try {
      const first = generateOccurrences(input, { limit: 1 })[0];
      if (!first) return null;
      return {
        // Persist a real resolved instant for all-day boundaries so the
        // UTC scheduler can select them; the wall date stays the key.
        nextAt: first.instantIso,
        nextLocal: first.allDay ? first.local : first.wall,
        seq: first.index,
      };
    } catch {
      return null;
    }
  }

  private recomputeNextOccurrence(id: string): void {
    const row = this.getTaskRow(id);
    if (!row) return;
    if (!row["rrule"] || !row["dtstart_local"]) {
      this.db
        .prepare(
          "UPDATE tasks SET next_occurrence_at = NULL, next_occurrence_local = NULL, occurrence_seq = 0 WHERE id = ?",
        )
        .run(id);
      return;
    }
    const first = this.firstOccurrenceFromValues(row, this.timezoneFor(row));
    if (!first) {
      throw new AgentError(
        "invalid_recurrence",
        "That recurrence could not be parsed. Check the rule and start date.",
        400,
      );
    }
    this.db
      .prepare(
        "UPDATE tasks SET next_occurrence_at = ?, next_occurrence_local = ?, occurrence_seq = ? WHERE id = ?",
      )
      .run(first.nextAt, first.nextLocal, first.seq, id);
  }

  private assertWritable(
    row: TaskRow | null,
    id: string,
    expectedRev?: number,
  ): void {
    if (!row || row["deleted_at"] != null) {
      throw new AgentError("not_found", `Task ${id} was not found.`, 404);
    }
    if (expectedRev !== undefined && Number(row.rev) !== expectedRev) {
      throw new AgentError(
        "stale_revision",
        `Task ${id} changed (rev ${row.rev}, expected ${expectedRev}). Re-read it and try again.`,
        412,
      );
    }
  }

  private occurrenceKeyFor(
    row: TaskRow,
    explicit: string | undefined,
    now: string,
  ): string {
    if (explicit) return explicit;
    if (row["next_occurrence_at"]) return String(row["next_occurrence_at"]);
    if (row["due_at"]) return String(row["due_at"]);
    if (row["due_date"]) return String(row["due_date"]).slice(0, 10);
    return wallDateInZone(now, this.timezone());
  }

  private insertCompletion(
    taskId: string,
    occurrenceKey: string,
    status: "completed" | "skipped",
    now: string,
  ): Record<string, unknown> | null {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_completions
           (id, task_id, occurrence_key, status, completed_at, source, rev, created_at)
         VALUES (?, ?, ?, ?, ?, 'user', 1, ?)`,
      )
      .run(newId(), taskId, occurrenceKey, status, now, now);
    return (
      (this.db
        .prepare(
          "SELECT * FROM task_completions WHERE task_id = ? AND occurrence_key = ? AND deleted_at IS NULL",
        )
        .get(taskId, occurrenceKey) as Record<string, unknown> | undefined) ??
      null
    );
  }

  private cancelPendingDeliveries(taskId: string): void {
    try {
      this.db
        .prepare(
          "DELETE FROM deliveries WHERE task_id = ? AND status IN ('pending','retry')",
        )
        .run(taskId);
    } catch {
      // Delivery lifecycle is best-effort from the agent boundary.
    }
  }

  private recurrenceInput(
    row: TaskRow,
    fallbackTz: string,
  ): RecurrenceInput | null {
    if (!row["rrule"] || !row["dtstart_local"]) return null;
    return {
      rrule: String(row["rrule"]),
      dtstartLocal: String(row["dtstart_local"]),
      timezone: String(row["timezone"] ?? fallbackTz),
      count: row["recurrence_count"] == null ? null : Number(row["recurrence_count"]),
      untilUtc: (row["recurrence_until_utc"] as string | null) ?? null,
      untilDate: (row["recurrence_until_date"] as string | null) ?? null,
      wkst: (row["wkst"] as string | null) ?? null,
      clampPolicy: row["clamp_policy"] === "last-day" ? "last-day" : "skip",
      allDay: row["all_day"] === 1 || row["all_day"] === true,
      reminderTimeLocal: (row["reminder_time_local"] as string | null) ?? null,
    };
  }

  /**
   * Mirror M1 completion semantics: advance a recurring series (or end it),
   * and mark a one-shot skipped task cancelled. Callers own the transaction.
   */
  private advanceRecurrence(
    row: TaskRow,
    occurrenceKey: string,
    now: string,
    reason: "complete" | "skip",
  ): void {
    const userTz = this.timezone();
    const input = this.recurrenceInput(row, userTz);
    if (!input) {
      if (reason === "complete") {
        this.db
          .prepare(
            `UPDATE tasks SET status = 'done', completed_at = ?, rev = rev + 1,
               updated_at = ?, updated_by = 'agent' WHERE id = ?`,
          )
          .run(now, now, row.id);
      } else {
        this.db
          .prepare(
            `UPDATE tasks SET status = 'cancelled', rev = rev + 1,
               updated_at = ?, updated_by = 'agent' WHERE id = ?`,
          )
          .run(now, row.id);
      }
      return;
    }
    let occurrenceInstant = occurrenceKey;
    try {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(occurrenceKey)) {
        const time = normalizeWallTime(
          (row["reminder_time_local"] as string | null) ?? "09:00:00",
        );
        occurrenceInstant = resolveWallTime(
          `${occurrenceKey}T${time}`,
          input.timezone,
        ).instantIso;
      }
      const mode =
        row["recurrence_mode"] === "completion" ? "completion" : "schedule";
      // Imported lazily to keep the pure recurrence helpers in one dependency.
      const next = nextOccurrenceForMode(input, {
        mode,
        occurrenceInstant,
        completedAt: now,
      });
      if (!next) {
        this.db
          .prepare(
            `UPDATE tasks SET status = 'done', completed_at = ?, series_ended_at = ?,
               next_occurrence_at = NULL, next_occurrence_local = NULL,
               rev = rev + 1, updated_at = ?, updated_by = 'agent' WHERE id = ?`,
          )
          .run(now, now, now, row.id);
        return;
      }
      this.db
        .prepare(
          `UPDATE tasks SET next_occurrence_at = ?, next_occurrence_local = ?,
             occurrence_seq = ?, completed_at = ?, rev = rev + 1,
             updated_at = ?, updated_by = 'agent' WHERE id = ?`,
        )
        .run(
          next.allDay ? null : next.instantIso,
          next.local,
          next.index,
          now,
          now,
          row.id,
        );
    } catch {
      // A stored rule that no longer parses must not strand completion; keep
      // the task open and let the user repair the recurrence.
      if (reason === "skip") {
        // no-op
      }
    }
  }

  softDeleteTask(id: string, expectedRev?: number): { before: TaskView; after: TaskView } {
    const row = this.getTaskRow(id);
    if (!row || row["deleted_at"] != null) {
      throw new AgentError("not_found", `Task ${id} was not found.`, 404);
    }
    if (expectedRev !== undefined && Number(row.rev) !== expectedRev) {
      throw new AgentError(
        "stale_revision",
        `Task ${id} changed (rev ${row.rev}, expected ${expectedRev}). Re-read it and try again.`,
        412,
      );
    }
    const now = nowIso();
    this.db
      .prepare(
        "UPDATE tasks SET deleted_at = ?, rev = rev + 1, updated_at = ?, updated_by = 'agent' WHERE id = ?",
      )
      .run(now, now, id);
    this.cancelPendingDeliveries(id);
    const after = this.getTaskRow(id);
    if (!after) throw new AgentError("write_failed", "Task was not persisted.", 500);
    return { before: toTaskView(row), after: toTaskView(after) };
  }

  /**
   * Undo helper: write a prior row back through a fixed column allowlist.
   * `id`, ownership and clock columns are never taken from the snapshot: the
   * row id is only a validated WHERE key and rev/updated_at are bumped by
   * undo itself. Unknown keys are rejected with a typed error rather than
   * interpolated into SQL.
   */
  restoreTaskRow(row: Record<string, unknown>, expectedId?: string): void {
    const id = row["id"];
    if (typeof id !== "string" || id.length === 0 || id.length > 64) {
      throw new AgentError(
        "invalid_snapshot",
        "Undo snapshot is missing a valid task id.",
        400,
      );
    }
    if (expectedId !== undefined && id !== expectedId) {
      throw new AgentError(
        "invalid_snapshot",
        "Undo snapshot points at a different task than the activity row.",
        400,
      );
    }
    const access = this.accessClause("t");
    const accessible = this.db
      .prepare(`SELECT 1 AS ok FROM tasks t WHERE t.id = ? AND ${access.sql}`)
      .get(id, ...access.args) as { ok: number } | undefined;
    if (!accessible) {
      throw new AgentError(
        "not_found",
        `Task ${id} was not found.`,
        404,
      );
    }
    // Do not restore a snapshot into a list the actor can no longer access.
    // The current row check above only covers the task's present location.
    const targetListId = row["list_id"];
    if (typeof targetListId === "string" && targetListId) {
      const actorId = this.getUser().id;
      const listAccessible = this.db
        .prepare(
          `SELECT 1 AS ok FROM lists l
            WHERE l.id = ?
              AND (l.user_id = ? OR EXISTS (
                SELECT 1 FROM list_members lm
                 WHERE lm.list_id = l.id AND lm.user_id = ?
              ))`,
        )
        .get(targetListId, actorId, actorId) as { ok: number } | undefined;
      if (!listAccessible) {
        throw new AgentError(
          "undo_conflict",
          "That undo would restore the task into a list you can no longer access.",
          409,
        );
      }
    }
    const columns: string[] = [];
    for (const column of Object.keys(row)) {
      if (TASK_PROTECTED_UNDO_COLUMNS.has(column)) continue;
      if (
        !TASK_UNDO_WRITABLE_COLUMNS.has(column) ||
        !SAFE_COLUMN_RE.test(column)
      ) {
        throw new AgentError(
          "invalid_snapshot",
          `Undo snapshot contains a non-undoable task column: ${column.slice(0, 64)}.`,
          400,
        );
      }
      columns.push(column);
    }
    const assignments = columns.map((column) => `"${column}" = ?`);
    assignments.push("rev = rev + 1", "updated_at = ?");
    this.db
      .prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`)
      .run(
        ...columns.map((column) => row[column] ?? null),
        nowIso(),
        id,
      );
  }

  softDeleteCompletion(id: string, expectedTaskId?: string): void {
    if (typeof id !== "string" || id.length === 0 || id.length > 64) {
      throw new AgentError(
        "invalid_snapshot",
        "Undo snapshot is missing a valid completion id.",
        400,
      );
    }
    const access = this.accessClause("t");
    const accessible = this.db
      .prepare(
        `SELECT 1 AS ok FROM task_completions c
           JOIN tasks t ON t.id = c.task_id
          WHERE c.id = ?${expectedTaskId === undefined ? "" : " AND c.task_id = ?"}
            AND ${access.sql}`,
      )
      .get(
        id,
        ...(expectedTaskId === undefined ? [] : [expectedTaskId]),
        ...access.args,
      ) as { ok: number } | undefined;
    if (!accessible) {
      throw new AgentError(
        "not_found",
        `Completion ${id} was not found.`,
        404,
      );
    }
    this.db
      .prepare(
        `UPDATE task_completions
            SET deleted_at = ?, rev = rev + 1
          WHERE id = ?${expectedTaskId === undefined ? "" : " AND task_id = ?"}`,
      )
      .run(
        nowIso(),
        id,
        ...(expectedTaskId === undefined ? [] : [expectedTaskId]),
      );
  }

  insertActivity(entry: ActivityWrite & { actor: string; actorId: string }): number {
    const result = this.db
      .prepare(
        `INSERT INTO activity
           (batch_id, op_id, actor, actor_id, action, entity_type, entity_id,
            before_json, after_json, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.batchId ?? null,
        entry.opId ?? null,
        entry.actor,
        entry.actorId,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.before == null ? null : JSON.stringify(entry.before),
        entry.after == null ? null : JSON.stringify(entry.after),
        entry.summary,
        nowIso(),
      );
    return Number(result.lastInsertRowid);
  }

  activityForBatch(batchId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM activity WHERE batch_id = ? ORDER BY seq ASC")
      .all(batchId) as Array<Record<string, unknown>>;
  }

  activitySeq(seq: number): Record<string, unknown> | null {
    return (
      (this.db.prepare("SELECT * FROM activity WHERE seq = ?").get(seq) as
        | Record<string, unknown>
        | undefined) ?? null
    );
  }

  // -------------------------------------------------------------------------
  // conversations / messages
  // -------------------------------------------------------------------------

  createConversation(title: string | null = null): ConversationRecord {
    const userId = this.getUser().id;
    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO agent_conversations
           (id, user_id, opencode_session_id, title, status, last_message_at,
            rev, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'active', NULL, 1, ?, ?)`,
      )
      .run(id, userId, title, now, now);
    const row = this.getConversationRow(id);
    if (!row) throw new AgentError("write_failed", "Conversation was not persisted.", 500);
    return toConversation(row);
  }

  getConversationRow(id: string): Record<string, unknown> | null {
    return (
      (this.db
        .prepare("SELECT * FROM agent_conversations WHERE id = ? AND deleted_at IS NULL")
        .get(id) as Record<string, unknown> | undefined) ?? null
    );
  }

  getConversation(id: string): ConversationRecord | null {
    const row = this.getConversationRow(id);
    return row ? toConversation(row) : null;
  }

  listConversations(limit = 20): ConversationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_conversations WHERE user_id = ? AND deleted_at IS NULL
         ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?`,
      )
      .all(this.getUser().id, Math.min(100, Math.max(1, limit))) as Array<
      Record<string, unknown>
    >;
    return rows.map(toConversation);
  }

  conversationBySession(sessionId: string): ConversationRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM agent_conversations WHERE opencode_session_id = ? AND deleted_at IS NULL LIMIT 1",
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? toConversation(row) : null;
  }

  setConversationSession(id: string, sessionId: string | null): void {
    this.db
      .prepare(
        "UPDATE agent_conversations SET opencode_session_id = ?, rev = rev + 1, updated_at = ? WHERE id = ?",
      )
      .run(sessionId, nowIso(), id);
  }

  setConversationError(
    id: string,
    error: { code?: string | null; message: string },
  ): void {
    const at = nowIso();
    this.db
      .prepare(
        `UPDATE agent_conversations
         SET last_error_code = ?, last_error_message = ?, last_error_at = ?,
             rev = rev + 1, updated_at = ? WHERE id = ?`,
      )
      .run(error.code ?? null, error.message.slice(0, 300), at, at, id);
  }

  clearConversationError(id: string): void {
    this.db
      .prepare(
        `UPDATE agent_conversations
         SET last_error_code = NULL, last_error_message = NULL,
             last_error_at = NULL, rev = rev + 1, updated_at = ? WHERE id = ?`,
      )
      .run(nowIso(), id);
  }

  touchConversation(id: string, title?: string): void {
    const now = nowIso();
    if (title) {
      this.db
        .prepare(
          "UPDATE agent_conversations SET last_message_at = ?, title = COALESCE(title, ?), rev = rev + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, title, now, id);
    } else {
      this.db
        .prepare(
          "UPDATE agent_conversations SET last_message_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, now, id);
    }
  }

  addMessage(input: {
    conversationId: string;
    role: "user" | "assistant" | "system";
    content: string;
    opencodeMessageId?: string | null;
    parts?: unknown;
  }): AssistantMessageRecord {
    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO agent_messages
           (id, conversation_id, role, content, parts_json, opencode_message_id,
            rev, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.role,
        input.content,
        input.parts === undefined ? null : JSON.stringify(input.parts),
        input.opencodeMessageId ?? null,
        now,
      );
    this.touchConversation(input.conversationId);
    return {
      id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      opencodeMessageId: input.opencodeMessageId ?? null,
      createdAt: now,
    };
  }

  /**
   * Link the optimistic local user message to OpenCode's copy instead of
   * inserting a duplicate after a resync. Prefers the exact OpenCode message
   * id when it is known; content matching is legacy fallback only.
   */
  linkUserMessage(
    conversationId: string,
    content: string,
    opencodeMessageId: string,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM agent_messages
         WHERE conversation_id = ? AND role = 'user' AND opencode_message_id IS NULL
           AND content = ? AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(conversationId, content) as { id: string } | undefined;
    if (!row) return false;
    this.db
      .prepare("UPDATE agent_messages SET opencode_message_id = ? WHERE id = ?")
      .run(opencodeMessageId, row.id);
    return true;
  }

  /**
   * Attach the OpenCode user message id to a specific local message. Used
   * right after `prompt()` returns, so identical prompt text never cross-links.
   */
  linkUserMessageById(
    localMessageId: string,
    opencodeMessageId: string,
  ): boolean {
    if (!opencodeMessageId) return false;
    const result = this.db
      .prepare(
        `UPDATE agent_messages SET opencode_message_id = ?
         WHERE id = ? AND (opencode_message_id IS NULL OR opencode_message_id != ?)`,
      )
      .run(opencodeMessageId, localMessageId, opencodeMessageId);
    return result.changes > 0;
  }

  /** Fetch a single local message by id (for post-prompt id publish). */
  getMessage(id: string): AssistantMessageRecord | null {
    const row = this.db
      .prepare("SELECT * FROM agent_messages WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row["id"]),
      conversationId: String(row["conversation_id"]),
      role: String(row["role"]) as AssistantMessageRecord["role"],
      content: String(row["content"] ?? ""),
      opencodeMessageId:
        (row["opencode_message_id"] as string | null | undefined) ?? null,
      createdAt: String(row["created_at"]),
    };
  }

  messageByOpenCodeId(
    conversationId: string,
    opencodeMessageId: string,
  ): Record<string, unknown> | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM agent_messages WHERE conversation_id = ? AND opencode_message_id = ? AND deleted_at IS NULL LIMIT 1",
        )
        .get(conversationId, opencodeMessageId) as
        | Record<string, unknown>
        | undefined) ?? null
    );
  }

  listMessages(conversationId: string, limit = 200): AssistantMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_messages WHERE conversation_id = ? AND deleted_at IS NULL
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(conversationId, Math.min(500, Math.max(1, limit))) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: String(row["id"]),
      conversationId: String(row["conversation_id"]),
      role: String(row["role"]) as AssistantMessageRecord["role"],
      content: String(row["content"] ?? ""),
      opencodeMessageId:
        (row["opencode_message_id"] as string | null | undefined) ?? null,
      createdAt: String(row["created_at"]),
    }));
  }

  // -------------------------------------------------------------------------
  // proposals
  // -------------------------------------------------------------------------

  createProposal(input: {
    conversationId: string | null;
    summary: string;
    operations: ProposalOperation[];
    baseRev: number;
    expiresAt: string;
  }): ProposalRecord {
    const id = newId();
    const now = nowIso();
    const payloadHash = hashPayload(input.operations);
    this.db
      .prepare(
        `INSERT INTO proposals
           (id, conversation_id, summary, operations_json, base_rev, payload_hash,
            expires_at, status, rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.summary,
        JSON.stringify(input.operations),
        input.baseRev,
        payloadHash,
        input.expiresAt,
        now,
        now,
      );
    const row = this.getProposalRow(id);
    if (!row) throw new AgentError("write_failed", "Proposal was not persisted.", 500);
    return toProposal(row);
  }

  getProposalRow(id: string): Record<string, unknown> | null {
    return (
      (this.db
        .prepare("SELECT * FROM proposals WHERE id = ? AND deleted_at IS NULL")
        .get(id) as Record<string, unknown> | undefined) ?? null
    );
  }

  getProposal(id: string): ProposalRecord | null {
    const row = this.getProposalRow(id);
    return row ? toProposal(row) : null;
  }

  listProposals(opts: { status?: string; conversationId?: string; limit?: number } = {}): ProposalRecord[] {
    const where = ["deleted_at IS NULL"];
    const args: unknown[] = [];
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.conversationId) {
      where.push("conversation_id = ?");
      args.push(opts.conversationId);
    }
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const rows = this.db
      .prepare(
        `SELECT * FROM proposals WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...args, limit) as Array<Record<string, unknown>>;
    return rows.map(toProposal);
  }

  pendingProposalOperations(conversationId: string | null): number {
    if (!conversationId) {
      const row = this.db
        .prepare("SELECT operations_json FROM proposals WHERE status = 'pending' AND deleted_at IS NULL")
        .all() as Array<{ operations_json: string }>;
      return row.reduce((sum, item) => sum + jsonLength(item.operations_json), 0);
    }
    const rows = this.db
      .prepare(
        "SELECT operations_json FROM proposals WHERE conversation_id = ? AND status = 'pending' AND deleted_at IS NULL",
      )
      .all(conversationId) as Array<{ operations_json: string }>;
    return rows.reduce((sum, item) => sum + jsonLength(item.operations_json), 0);
  }

  expireProposals(): number {
    const now = nowIso();
    const result = this.db
      .prepare(
        "UPDATE proposals SET status = 'expired', rev = rev + 1, updated_at = ? WHERE status = 'pending' AND expires_at <= ?",
      )
      .run(now, now);
    return result.changes;
  }

  markProposal(
    id: string,
    status: "applied" | "dismissed" | "expired",
    appliedRev?: number | null,
    appliedActivityId?: number | null,
  ): void {
    this.db
      .prepare(
        `UPDATE proposals SET status = ?, applied_rev = COALESCE(?, applied_rev),
           applied_activity_id = COALESCE(?, applied_activity_id),
           rev = rev + 1, updated_at = ? WHERE id = ?`,
      )
      .run(
        status,
        appliedRev ?? null,
        appliedActivityId ?? null,
        nowIso(),
        id,
      );
  }
}

function jsonLength(value: string): number {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function toConversation(row: Record<string, unknown>): ConversationRecord {
  const message =
    (row["last_error_message"] as string | null | undefined) ?? null;
  const at = (row["last_error_at"] as string | null | undefined) ?? null;
  return {
    id: String(row["id"]),
    opencodeSessionId:
      (row["opencode_session_id"] as string | null | undefined) ?? null,
    title: (row["title"] as string | null | undefined) ?? null,
    status: String(row["status"] ?? "active") as ConversationRecord["status"],
    lastMessageAt:
      (row["last_message_at"] as string | null | undefined) ?? null,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    lastError:
      message && at
        ? {
            code:
              (row["last_error_code"] as string | null | undefined) ?? null,
            message,
            at,
          }
        : null,
  };
}

export function parseOperations(value: string): ProposalOperation[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as ProposalOperation[]) : [];
  } catch {
    return [];
  }
}

export function toProposal(row: Record<string, unknown>): ProposalRecord {
  const operations = parseOperations(String(row["operations_json"] ?? "[]"));
  return {
    id: String(row["id"]),
    conversationId:
      (row["conversation_id"] as string | null | undefined) ?? null,
    summary: String(row["summary"] ?? ""),
    operations,
    baseRev: row["base_rev"] == null ? null : Number(row["base_rev"]),
    payloadHash: String(row["payload_hash"] ?? ""),
    expiresAt: String(row["expires_at"] ?? ""),
    status: String(row["status"] ?? "pending") as ProposalRecord["status"],
    appliedRev: row["applied_rev"] == null ? null : Number(row["applied_rev"]),
    appliedActivityId:
      row["applied_activity_id"] == null
        ? null
        : Number(row["applied_activity_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    rev: Number(row["rev"] ?? 1),
    preview: [],
  };
}
