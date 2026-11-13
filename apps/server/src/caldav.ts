/**
 * Calendar integration (v0.3 VTODO collections).
 *
 * - `GET /api/calendar.ics?token=…` is the existing read-only VEVENT feed.
 * - `GET /api/tasks.ics?token=…` is a separate VTODO feed; the VEVENT feed is
 *   deliberately unchanged.
 * - `/caldav/…` exposes one VTODO collection per accessible list plus the
 *   virtual Inbox: principal/calendar-home discovery, PROPFIND,
 *   calendar-query/calendar-multiget REPORT, sync-collection, collection
 *   management, GET, PUT, DELETE, and MOVE. The legacy all-tasks `morrow`
 *   alias stays readable for older subscribers but rejects every write.
 *
 * Identity:
 * - `tasks.ical_uid` is the client UID (falls back to `<id>@morrow`).
 * - `tasks.caldav_href` is the client-chosen relative resource path (falls
 *   back to `<id>.ics`).
 * - UID/href uniqueness is per collection among live rows.
 *
 * Auth uses a CalDAV-scoped credential: username `owner`, password = a token
 * created with `kind: "caldav"` in Settings → Integrations. Capture/email
 * tokens are deliberately rejected. `CALDAV_TOKEN` is a deprecated
 * headless-deployment fallback that maps only to the workspace owner — never
 * to an arbitrary earliest-created user in a multi-account workspace.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "@morrow/db";
import {
  assertValidRecurrence,
  deriveReminder,
  initialSortKey,
  isValidTimeZone,
  newId,
  nowIso,
  resolveWallTime,
  uuidSchema,
  wallDateTimeInZone,
} from "@morrow/shared";
import { canAccessList, canAccessTask } from "./access.js";
import { sha256Hex } from "./auth.js";
import { requireAuth } from "./authz.js";
import {
  attachmentRowById,
  contentDispositionFilename,
  safeAttachmentPath,
} from "./attachments.js";
import { cancelPendingDeliveriesForTaskIds } from "./deliveries.js";
import {
  fingerprintParts,
  importFingerprint,
  MAX_ICS_BYTES,
  parseIcsFile,
  type ImportedIcsObject,
} from "./icsImport.js";
import { findInboxIdentityConflicts, writeActivityTx } from "./lists.js";
import {
  CalDavIcsError,
  caldavHrefFor,
  calendarObjectForTask,
  entityTagMatches,
  escapeIcs,
  foldLine,
  icalUidFor,
  icsDate,
  icsUtc,
  parseCalDavIcs,
  parseEntityTagHeader,
  parseDurationMinutes,
  priorityFromIcal,
  vtodoFeed,
  type CalDavTag,
  type CalDavTask,
  type ParsedDateValue,
  type ParsedEntityTags,
  type ParsedVtodo,
} from "./caldavVtodo.js";
import { utcTimezone } from "./vtimezone.js";
import {
  changesSinceCollection,
  isUsableSyncToken,
  INBOX_COLLECTION,
  LEGACY_COLLECTION,
  parseSyncToken,
  maxChangeSeqForCollection,
  readSyncEpoch,
  syncTokenFor,
  type CalDavChangeRow,
} from "./caldavSync.js";
import { badRequest, notFound, sendProblem } from "./errors.js";

const CALDAV_CALENDARS = "/caldav/calendars/";
const PRODID = "-//Morrow//Reminders//EN";

interface CalendarUser {
  id: string;
  username: string;
  timezone: string;
}

/** A task row plus the fields the collection layer needs (serializer ignores them). */
type CalTask = CalDavTask & {
  user_id: string;
  list_id: string | null;
};

interface CalDavCollection {
  key: string;
  path: string;
  name: string;
  color: string | null;
  kind: "all" | "inbox" | "list";
  listId: string | null;
  ownerId: string;
  shared: boolean;
  viewerId: string;
}

interface CalDavExceptionRow {
  id: string;
  task_id: string;
  user_id: string;
  recurrence_id: string;
  caldav_href: string;
  patch_json: string;
  status: string | null;
  completed_at: string | null;
  ical_extra_json: string | null;
  rev: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function collectionPath(key: string): string {
  return `${CALDAV_CALENDARS}${key}/`;
}

// ---------------------------------------------------------------------------
// VEVENT subscription feed (kept byte-compatible with the pre-Round-4 feed)
// ---------------------------------------------------------------------------

function taskToEvent(task: CalTask): string {
  const uid = `${task.id}@morrow`;
  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsUtc(task.updated_at)}`,
    `LAST-MODIFIED:${icsUtc(task.updated_at)}`,
    `SUMMARY:${escapeIcs(task.title)}`,
  ];
  if (task.notes) lines.push(`DESCRIPTION:${escapeIcs(task.notes)}`);
  const allDay = task.all_day === 1;
  const dtstart = allDay
    ? task.due_date
    : task.dtstart_local && task.rrule
      ? null
      : task.due_at;
  if (allDay && task.due_date) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(task.due_date.slice(0, 10))}`);
    lines.push(
      `DTEND;VALUE=DATE:${icsDate(
        new Date(Date.parse(`${task.due_date.slice(0, 10)}T00:00:00Z`) + 86400000)
          .toISOString()
          .slice(0, 10),
      )}`,
    );
  } else if (dtstart) {
    lines.push(`DTSTART:${icsUtc(dtstart)}`);
    lines.push(
      `DTEND:${icsUtc(new Date(Date.parse(dtstart) + 60 * 60 * 1000).toISOString())}`,
    );
  } else if (task.rrule && task.dtstart_local) {
    // Recurring wall-time series without a concrete due field: emit the
    // floating local start and let RRULE carry the repetition.
    lines.push(`DTSTART:${task.dtstart_local.replace(/[-:]/g, "").replace("T", "T")}`);
  }
  if (task.rrule) {
    const rule = task.rrule.replace(/^RRULE:/i, "");
    const extra = [
      rule,
      task.recurrence_count ? `COUNT=${task.recurrence_count}` : null,
      task.recurrence_until_date
        ? `UNTIL=${icsDate(task.recurrence_until_date.slice(0, 10))}`
        : null,
    ]
      .filter(Boolean)
      .join(";");
    lines.push(`RRULE:${extra}`);
  }
  if (task.status === "done") {
    lines.push("STATUS:COMPLETED");
    if (task.completed_at) lines.push(`COMPLETED:${icsUtc(task.completed_at)}`);
  } else if (task.status === "cancelled") {
    lines.push("STATUS:CANCELLED");
  }
  if (task.priority >= 3) lines.push(`PRIORITY:${task.priority === 4 ? 1 : 5}`);
  if (task.remind_offset_minutes != null) {
    const minutes = Math.abs(task.remind_offset_minutes);
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push(`DESCRIPTION:${escapeIcs(task.title)}`);
    lines.push(
      `TRIGGER:${task.remind_offset_minutes <= 0 ? "-" : "+"}PT${minutes}M`,
    );
    lines.push("END:VALARM");
  }
  lines.push("END:VEVENT");
  return lines.map(foldLine).join("\r\n");
}

function calendarForTasks(tasks: CalTask[], name = "Morrow"): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(name)}`,
    ...tasks.map(taskToEvent),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function basicToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Basic\s+(.+)$/i.exec(header);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1] as string, "base64").toString("utf8");
    const index = decoded.indexOf(":");
    if (index < 0) return null;
    const username = decoded.slice(0, index);
    if (username !== "" && username !== "owner") return null;
    return decoded.slice(index + 1);
  } catch {
    return null;
  }
}

function tokenUser(raw: string | null): CalendarUser | null {
  if (!raw) return null;
  const db = getDb();
  let userId: string | null = null;
  try {
    const row = db
      .prepare(
        `SELECT user_id FROM capture_tokens
          WHERE token_hash = ? AND kind = 'caldav' AND revoked_at IS NULL`,
      )
      .get(sha256Hex(raw)) as { user_id: string } | undefined;
    userId = row?.user_id ?? null;
  } catch {
    userId = null;
  }
  if (!userId) {
    const envToken = process.env["CALDAV_TOKEN"]?.trim();
    if (envToken) {
      const a = Buffer.from(raw);
      const b = Buffer.from(envToken);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        // Deprecated env fallback. Owner-only: never pick "the first user" by
        // created_at in a multi-account workspace. Prefer a per-user
        // kind=caldav token from Settings.
        try {
          userId = caldavEnvFallbackUser(db)?.id ?? null;
        } catch {
          return null;
        }
      }
    }
  }
  if (!userId) return null;
  try {
    const user = db
      .prepare(
        "SELECT id, username, timezone FROM users WHERE id = ? AND deleted_at IS NULL",
      )
      .get(userId) as CalendarUser | undefined;
    return user ?? null;
  } catch {
    return null;
  }
}

/**
 * Test/diagnostic helper for the deprecated CALDAV_TOKEN fallback: it resolves
 * only the owner, never the earliest-created member.
 */
export function caldavEnvFallbackUser(
  db: ReturnType<typeof getDb> = getDb(),
): CalendarUser | null {
  try {
    const row = db
      .prepare(
        `SELECT id, username, timezone FROM users
          WHERE role = 'owner' AND deleted_at IS NULL
          ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get() as CalendarUser | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function requestUser(req: FastifyRequest, queryToken?: string): CalendarUser | null {
  const fromQuery = queryToken?.trim() ? queryToken.trim() : null;
  return tokenUser(fromQuery ?? basicToken(req));
}

function challenge(req: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendProblem(req, reply, 401, "Unauthorized", {
    detail: "Use Basic auth with username 'owner' and a CalDAV token, or ?token=.",
    code: "unauthorized",
  }).header("WWW-Authenticate", 'Basic realm="Morrow CalDAV"');
}

function requireUser(
  req: FastifyRequest,
  reply: FastifyReply,
  queryToken?: string,
): CalendarUser | null {
  const user = requestUser(req, queryToken);
  if (!user) {
    challenge(req, reply);
    return null;
  }
  return user;
}

// ---------------------------------------------------------------------------
// Queries / identity / tags
// ---------------------------------------------------------------------------

const CALDAV_TASK_COLUMNS = `t.id, t.user_id, t.list_id, t.ical_uid,
  t.caldav_href, t.title, t.notes, t.status, t.priority, t.due_at,
  t.due_date, t.all_day, t.timezone, t.remind_at, t.reminder_time_local,
  t.remind_offset_minutes, t.dtstart_local, t.next_occurrence_at,
  t.next_occurrence_local, t.rrule, t.recurrence_until_date,
  t.recurrence_count, t.completed_at, t.rev, t.created_at, t.updated_at,
  (SELECT json_group_array(
            json_object('id', a.id, 'filename', a.filename,
                        'mimeType', a.mime_type, 'bytes', a.bytes))
     FROM attachments a
    WHERE a.task_id = t.id AND a.deleted_at IS NULL) AS attachments_json,
  (SELECT json_group_array(e.recurrence_id)
     FROM task_recurrence_exceptions e
    WHERE e.task_id = t.id AND e.deleted_at IS NULL
      AND COALESCE(e.status, 'open') = 'cancelled'
      AND e.patch_json = '{}'
      AND e.ical_extra_json IS NULL) AS exdates_json`;

function inboxCollection(userId: string): CalDavCollection {
  return {
    key: INBOX_COLLECTION,
    path: collectionPath(INBOX_COLLECTION),
    name: "Inbox",
    color: null,
    kind: "inbox",
    listId: null,
    ownerId: userId,
    shared: false,
    viewerId: userId,
  };
}

function allCollection(userId: string): CalDavCollection {
  return {
    key: LEGACY_COLLECTION,
    path: collectionPath(LEGACY_COLLECTION),
    name: "All tasks",
    color: null,
    kind: "all",
    listId: null,
    ownerId: userId,
    shared: false,
    viewerId: userId,
  };
}

function collectionsForUser(userId: string): CalDavCollection[] {
  const rows = getDb()
    .prepare(
      `SELECT l.id, l.name, l.color, l.user_id,
              CASE WHEN l.user_id = ? THEN 0 ELSE 1 END AS shared
         FROM lists l
        WHERE l.deleted_at IS NULL AND l.is_inbox = 0
          AND (l.user_id = ? OR EXISTS (
            SELECT 1 FROM list_members lm
             WHERE lm.list_id = l.id AND lm.user_id = ?
          ))
        ORDER BY l.sort_key ASC, l.id ASC`,
    )
    .all(userId, userId, userId) as Array<{
    id: string;
    name: string;
    color: string | null;
    user_id: string;
    shared: number;
  }>;
  const lists = rows.map(
    (row): CalDavCollection => ({
      key: row.id,
      path: collectionPath(row.id),
      name: row.name,
      color: row.color,
      kind: "list",
      listId: row.id,
      ownerId: row.user_id,
      shared: row.shared === 1,
      viewerId: userId,
    }),
  );
  return [inboxCollection(userId), ...lists];
}

function collectionByKey(
  userId: string,
  key: string,
): CalDavCollection | null {
  if (key === LEGACY_COLLECTION) return allCollection(userId);
  if (key === INBOX_COLLECTION) return inboxCollection(userId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return null;
  const row = getDb()
    .prepare(
      `SELECT l.id, l.name, l.color, l.user_id,
              CASE WHEN l.user_id = ? THEN 0 ELSE 1 END AS shared
         FROM lists l
        WHERE l.id = ? AND l.deleted_at IS NULL AND l.is_inbox = 0
          AND (l.user_id = ? OR EXISTS (
            SELECT 1 FROM list_members lm
             WHERE lm.list_id = l.id AND lm.user_id = ?
          ))
        LIMIT 1`,
    )
    .get(userId, key, userId, userId) as
    | {
        id: string;
        name: string;
        color: string | null;
        user_id: string;
        shared: number;
      }
    | undefined;
  if (!row) return null;
  return {
    key: row.id,
    path: collectionPath(row.id),
    name: row.name,
    color: row.color,
    kind: "list",
    listId: row.id,
    ownerId: row.user_id,
    shared: row.shared === 1,
    viewerId: userId,
  };
}

function resourceHref(collection: CalDavCollection, task: Pick<CalTask, "id" | "caldav_href">): string {
  return `${collection.path}${encodeHrefPath(caldavHrefFor(task))}`;
}

function xmlTextProperty(body: string, name: string): string | null {
  const match = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${name}>`,
    "i",
  ).exec(body);
  return match ? xmlUnescape((match[1] as string).trim()) : null;
}

function xmlEmptyProperty(body: string, name: string): boolean {
  return new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*/\\s*>`,
    "i",
  ).test(body);
}

function listRowById(id: string): Record<string, unknown> | null {
  const row = getDb()
    .prepare("SELECT * FROM lists WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ?? null;
}

function writeListActivity(
  userId: string,
  action: string,
  listId: string,
  before: unknown,
  after: unknown,
  summary: string,
): void {
  writeActivityTx({
    batchId: newId(),
    opId: null,
    actorId: userId,
    action,
    entityType: "list",
    entityId: listId,
    before,
    after,
    summary,
  });
}

function resourceHrefFor(collection: CalDavCollection, href: string): string {
  return `${collection.path}${encodeHrefPath(href)}`;
}

function collectionScope(collection: CalDavCollection): {
  where: string;
  params: unknown[];
} {
  if (collection.kind === "all") {
    return { where: "t.user_id = ?", params: [collection.viewerId] };
  }
  if (collection.kind === "inbox") {
    return {
      where:
        "t.user_id = ? AND (t.list_id IS NULL OR t.list_id = (SELECT id FROM lists WHERE user_id = ? AND is_inbox = 1 AND deleted_at IS NULL LIMIT 1))",
      params: [collection.viewerId, collection.viewerId],
    };
  }
  return { where: "t.list_id = ?", params: [collection.listId] };
}

function tasksForCollection(
  collection: CalDavCollection,
  includeCancelled: boolean,
): CalTask[] {
  const scope = collectionScope(collection);
  return getDb()
    .prepare(
      `SELECT ${CALDAV_TASK_COLUMNS}
         FROM tasks t
        WHERE ${scope.where} AND t.deleted_at IS NULL
          ${includeCancelled ? "" : "AND t.status != 'cancelled'"}
        ORDER BY t.updated_at DESC, t.id DESC`,
    )
    .all(...scope.params) as CalTask[];
}

function tasksOwnedByUser(
  userId: string,
  includeCancelled: boolean,
): CalTask[] {
  return getDb()
    .prepare(
      `SELECT ${CALDAV_TASK_COLUMNS}
         FROM tasks t
        WHERE t.user_id = ? AND t.deleted_at IS NULL
          ${includeCancelled ? "" : "AND t.status != 'cancelled'"}
        ORDER BY t.updated_at DESC, t.id DESC`,
    )
    .all(userId) as CalTask[];
}

function taskForCollectionHref(
  collection: CalDavCollection,
  href: string,
): CalTask | null {
  const scope = collectionScope(collection);
  const row = getDb()
    .prepare(
      `SELECT ${CALDAV_TASK_COLUMNS}
         FROM tasks t
        WHERE ${scope.where} AND t.deleted_at IS NULL
          AND (t.caldav_href = ? OR (t.caldav_href IS NULL AND t.id || '.ics' = ?))`,
    )
    .get(...scope.params, href, href) as CalTask | undefined;
  return row ?? null;
}

function taskForCollectionId(
  collection: CalDavCollection,
  id: string,
): CalTask | null {
  const scope = collectionScope(collection);
  const row = getDb()
    .prepare(
      `SELECT ${CALDAV_TASK_COLUMNS}
         FROM tasks t
        WHERE ${scope.where} AND t.deleted_at IS NULL AND t.id = ?`,
    )
    .get(...scope.params, id) as CalTask | undefined;
  return row ?? null;
}

const EXCEPTION_SELECT = `e.id AS exception_id, e.task_id AS exception_task_id,
  e.user_id AS exception_user_id, e.recurrence_id AS exception_recurrence_id,
  e.caldav_href AS exception_caldav_href, e.patch_json AS exception_patch_json,
  e.status AS exception_status, e.completed_at AS exception_completed_at,
  e.ical_extra_json AS exception_ical_extra_json, e.rev AS exception_rev,
  e.created_at AS exception_created_at, e.updated_at AS exception_updated_at`;

function exceptionFromRow(row: Record<string, unknown>): CalDavExceptionRow {
  return {
    id: String(row["exception_id"]),
    task_id: String(row["exception_task_id"]),
    user_id: String(row["exception_user_id"]),
    recurrence_id: String(row["exception_recurrence_id"]),
    caldav_href: String(row["exception_caldav_href"]),
    patch_json: String(row["exception_patch_json"] ?? "{}"),
    status:
      row["exception_status"] === null ||
      row["exception_status"] === undefined
        ? null
        : String(row["exception_status"]),
    completed_at:
      row["exception_completed_at"] === null ||
      row["exception_completed_at"] === undefined
        ? null
        : String(row["exception_completed_at"]),
    ical_extra_json:
      row["exception_ical_extra_json"] === null ||
      row["exception_ical_extra_json"] === undefined
        ? null
        : String(row["exception_ical_extra_json"]),
    rev: Number(row["exception_rev"] ?? 1),
    created_at: String(row["exception_created_at"]),
    updated_at: String(row["exception_updated_at"]),
    deleted_at: null,
  };
}

function exceptionPatch(exception: CalDavExceptionRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(exception.patch_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function virtualExceptionTask(
  row: Record<string, unknown>,
  exception: CalDavExceptionRow,
): CalTask {
  const base = row as unknown as CalTask;
  const patch = exceptionPatch(exception);
  const pick = <T>(key: string, fallback: T): T => {
    const value = patch[key];
    return value === undefined ? fallback : (value as T);
  };
  return {
    ...base,
    caldav_href: exception.caldav_href,
    title: pick("title", base.title),
    notes: pick("notes", base.notes),
    due_at: pick("dueAt", base.due_at),
    due_date: pick("dueDate", base.due_date),
    all_day: pick("allDay", base.all_day),
    priority: pick("priority", base.priority),
    dtstart_local: pick("dtstartLocal", base.dtstart_local),
    status: exception.status ?? "open",
    completed_at: exception.completed_at,
    recurrence_id: exception.recurrence_id,
    recurrence_range: null,
    rrule: null,
    recurrence_until_date: null,
    recurrence_count: null,
    rev: Math.max(base.rev, exception.rev),
    created_at: exception.created_at,
    updated_at: exception.updated_at,
  };
}

function exceptionsForCollection(
  collection: CalDavCollection,
  includeCancelled: boolean,
): CalTask[] {
  const scope = collectionScope(collection);
  const rows = getDb()
    .prepare(
      `SELECT ${CALDAV_TASK_COLUMNS}, ${EXCEPTION_SELECT}
         FROM task_recurrence_exceptions e
         JOIN tasks t ON t.id = e.task_id
        WHERE ${scope.where} AND t.deleted_at IS NULL AND e.deleted_at IS NULL
          ${includeCancelled ? "" : "AND COALESCE(e.status, 'open') != 'cancelled'"}
        ORDER BY t.updated_at DESC, e.updated_at DESC`,
    )
    .all(...scope.params) as Array<Record<string, unknown>>;
  return rows.map((row) => virtualExceptionTask(row, exceptionFromRow(row)));
}

function exceptionResourceForHref(
  collection: CalDavCollection,
  href: string,
): { task: CalTask; exception: CalDavExceptionRow } | null {
  const scope = collectionScope(collection);
  const row = getDb()
    .prepare(
      `SELECT ${CALDAV_TASK_COLUMNS}, ${EXCEPTION_SELECT}
         FROM task_recurrence_exceptions e
         JOIN tasks t ON t.id = e.task_id
        WHERE ${scope.where} AND t.deleted_at IS NULL AND e.deleted_at IS NULL
          AND e.caldav_href = ?
        LIMIT 1`,
    )
    .get(...scope.params, href) as Record<string, unknown> | undefined;
  if (!row) return null;
  const exception = exceptionFromRow(row);
  return { task: virtualExceptionTask(row, exception), exception };
}

function exceptionResourceForId(
  collection: CalDavCollection,
  id: string,
): { task: CalTask; exception: CalDavExceptionRow } | null {
  const scope = collectionScope(collection);
  const row = getDb()
    .prepare(
      `SELECT ${CALDAV_TASK_COLUMNS}, ${EXCEPTION_SELECT}
         FROM task_recurrence_exceptions e
         JOIN tasks t ON t.id = e.task_id
        WHERE ${scope.where} AND t.deleted_at IS NULL AND e.deleted_at IS NULL
          AND e.id = ?
        LIMIT 1`,
    )
    .get(...scope.params, id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const exception = exceptionFromRow(row);
  return { task: virtualExceptionTask(row, exception), exception };
}

function resourcesForCollection(
  collection: CalDavCollection,
  includeCancelled: boolean,
): CalTask[] {
  return [
    ...tasksForCollection(collection, includeCancelled),
    ...exceptionsForCollection(collection, includeCancelled),
  ];
}

function resourceForCollectionHref(
  collection: CalDavCollection,
  href: string,
): { task: CalTask; exception: CalDavExceptionRow | null } | null {
  const base = taskForCollectionHref(collection, href);
  if (base) return { task: base, exception: null };
  const virtual = exceptionResourceForHref(collection, href);
  return virtual
    ? { task: virtual.task, exception: virtual.exception }
    : null;
}

function taskForCollectionUid(
  collection: CalDavCollection,
  uid: string,
): CalTask | null {
  const scope = collectionScope(collection);
  const row = getDb()
    .prepare(
      `SELECT ${CALDAV_TASK_COLUMNS}
         FROM tasks t
        WHERE ${scope.where} AND t.deleted_at IS NULL
          AND (t.ical_uid = ? OR (t.ical_uid IS NULL AND t.id || '@morrow' = ?))`,
    )
    .get(...scope.params, uid, uid) as CalTask | undefined;
  return row ?? null;
}

function tagsForUserTasks(userId: string): Map<string, CalDavTag[]> {
  const rows = getDb()
    .prepare(
      `SELECT tt.task_id, tg.name
         FROM task_tags tt
         JOIN tags tg ON tg.id = tt.tag_id
        WHERE tg.user_id = ? AND tg.deleted_at IS NULL
        ORDER BY lower(tg.name) ASC, tg.id ASC`,
    )
    .all(userId) as Array<{ task_id: string; name: string }>;
  const map = new Map<string, CalDavTag[]>();
  for (const row of rows) {
    const list = map.get(row.task_id) ?? [];
    list.push({ name: row.name });
    map.set(row.task_id, list);
  }
  return map;
}

function tagsForTask(userId: string, taskId: string): CalDavTag[] {
  const rows = getDb()
    .prepare(
      `SELECT tg.name
         FROM tags tg
         JOIN task_tags tt ON tt.tag_id = tg.id
        WHERE tt.task_id = ? AND tg.user_id = ? AND tg.deleted_at IS NULL
        ORDER BY lower(tg.name) ASC, tg.id ASC`,
    )
    .all(taskId, userId) as Array<{ name: string }>;
  return rows;
}

function applyCategories(
  userId: string,
  taskId: string,
  names: string[],
  now: string,
): void {
  if (names.length > 20) {
    throw new CalDavIcsError(
      "too_many_categories",
      "A task can carry at most 20 CATEGORIES.",
    );
  }
  const db = getDb();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const name = rawName.trim();
    if (name === "") continue;
    const key = name.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = db
      .prepare(
        `SELECT id FROM tags
          WHERE user_id = ? AND lower(name) = lower(?) AND deleted_at IS NULL
          LIMIT 1`,
      )
      .get(userId, name) as { id: string } | undefined;
    if (existing) {
      ids.push(existing.id);
    } else {
      const id = newId();
      db.prepare(
        `INSERT INTO tags (id, user_id, name, color, rev, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 1, ?, ?)`,
      ).run(id, userId, name, now, now);
      ids.push(id);
    }
  }
  // Only this user's task_tags membership is replaced; shared-list co-owners
  // keep their own labels.
  db.prepare(
    `DELETE FROM task_tags
      WHERE task_id = ?
        AND tag_id IN (SELECT id FROM tags WHERE user_id = ?)`,
  ).run(taskId, userId);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO task_tags (task_id, tag_id, created_at) VALUES (?, ?, ?)",
  );
  for (const tagId of ids) insert.run(taskId, tagId, now);
}

// ---------------------------------------------------------------------------
// Href / ETag / preconditions
// ---------------------------------------------------------------------------

function encodeHrefPath(href: string): string {
  return href.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/**
 * Parse `/calendars/<collection>/<href>` from the `/caldav/*` wildcard.
 * `home` means the calendar-home collection itself.
 */
function parseDavPath(
  normalized: string,
): { collectionKey: string; href: string | null } | "home" | null {
  if (normalized === "/calendars" || normalized === "/calendars/") {
    return "home";
  }
  if (!normalized.startsWith("/calendars/")) return null;
  const rest = normalized.slice("/calendars/".length);
  if (!rest) return "home";
  const slash = rest.indexOf("/");
  const collectionKey = slash < 0 ? rest : rest.slice(0, slash);
  if (!collectionKey) return null;
  if (slash < 0) return { collectionKey, href: null };
  const raw = rest.slice(slash + 1);
  if (raw === "") return { collectionKey, href: null };
  const href = normalizeHref(raw);
  return href ? { collectionKey, href } : null;
}

/**
 * Accept client-chosen relative resource paths (not just UUIDs). Reject
 * traversal, control characters, empty segments, and over-long paths.
 */
function normalizeHref(raw: string): string | null {
  let value = raw;
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  value = value.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!value || value.length > 512) return null;
  const segments = value.split("/");
  for (const segment of segments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.length > 128 ||
      segment.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(segment)
    ) {
      return null;
    }
  }
  return segments.join("/");
}

/**
 * Legacy compatibility: a top-level `<uuid>.ics` href still becomes that UUID
 * task id, matching the pre-Round-4 endpoint. Custom/non-UUID paths use a
 * generated id and are addressed by `caldav_href`.
 */
function idFromHref(href: string): string | null {
  if (href.includes("/")) return null;
  const base = href.replace(/\.ics$/i, "");
  if (!uuidSchema.safeParse(base).success) return null;
  const taken = getDb().prepare("SELECT 1 AS taken FROM tasks WHERE id = ?").get(base);
  return taken ? null : base;
}

function etagFor(task: CalTask, tags: CalDavTag[] = []): string {
  const representation = calendarObjectForTask(task, tags);
  return `"${crypto.createHash("sha1").update(representation).digest("hex")}"`;
}

function changeTokenFor(userId: string, collectionKey: string): string {
  // Per-collection ctag: only changes that can appear in this collection move
  // it. The restore epoch is part of the value so a journal reset cannot
  // reproduce a pre-restore ctag. Sync tokens use a global journal position
  // instead (see caldavSync).
  return `ctag-${readSyncEpoch(getDb())}-${maxChangeSeqForCollection(
    getDb(),
    userId,
    collectionKey,
  )}`;
}

function preconditionFailed(reply: FastifyReply, currentEtag: string | null): FastifyReply {
  if (currentEtag) reply.header("ETag", currentEtag);
  return reply.code(412).send();
}

/**
 * CalDAV conditional-write semantics. Unlike the REST API this does not
 * require If-Match, but a supplied header must match; If-None-Match: * blocks
 * overwriting an existing resource.
 */
function checkWritePreconditions(
  req: FastifyRequest,
  reply: FastifyReply,
  currentEtag: string | null,
): boolean {
  const ifMatchRaw = req.headers["if-match"];
  if (ifMatchRaw !== undefined) {
    const parsed = parseEntityTagHeader(ifMatchRaw);
    if (!parsed) {
      preconditionFailed(reply, currentEtag);
      return false;
    }
    if (parsed.wildcard) {
      if (!currentEtag) {
        preconditionFailed(reply, currentEtag);
        return false;
      }
    } else if (
      !currentEtag ||
      !entityTagMatches(parsed, currentEtag, false)
    ) {
      preconditionFailed(reply, currentEtag);
      return false;
    }
  }

  const ifNoneRaw = req.headers["if-none-match"];
  if (ifNoneRaw !== undefined) {
    const parsed = parseEntityTagHeader(ifNoneRaw);
    if (!parsed) {
      preconditionFailed(reply, currentEtag);
      return false;
    }
    if (parsed.wildcard) {
      if (currentEtag) {
        preconditionFailed(reply, currentEtag);
        return false;
      }
    } else if (
      currentEtag &&
      entityTagMatches(parsed, currentEtag, true)
    ) {
      preconditionFailed(reply, currentEtag);
      return false;
    }
  }
  return true;
}

function isUniqueConstraint(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNIQUE constraint failed: (tasks\.(ical_uid|caldav_href)|index 'tasks_collection_(ical_uid|caldav_href)_unique'|task_recurrence_exceptions\.(caldav_href|recurrence_id)|index 'task_recurrence_exceptions_(task_href|task_recurrence)_unique')/.test(
      err.message,
    )
  );
}

function isExceptionUniqueConstraint(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNIQUE constraint failed: (task_recurrence_exceptions\.|index 'task_recurrence_exceptions_)/.test(
      err.message,
    )
  );
}

// ---------------------------------------------------------------------------
// Write mapping
// ---------------------------------------------------------------------------

function wallFor(instant: string, tz: string): string {
  try {
    return wallDateTimeInZone(new Date(instant), tz);
  } catch {
    return instant.slice(0, 19);
  }
}

function upsertTask(
  user: CalendarUser,
  collection: CalDavCollection,
  parsed: ParsedVtodo,
  existing: CalTask | null,
  href: string,
  uid: string,
  reconcileExdates = true,
): CalTask {
  const db = getDb();
  // Preserve a real client TZID so the next representation keeps the same
  // wall-clock series. UTC/floating inputs retain the previous user-zone
  // fallback behaviour.
  const clientZone = [parsed.dtstart?.tzid, parsed.due?.tzid].find(
    (value): value is string =>
      Boolean(value) &&
      isValidTimeZone(value as string) &&
      !utcTimezone(value as string),
  );
  const tz =
    clientZone ??
    (isValidTimeZone(user.timezone) ? user.timezone : "UTC");
  const now = nowIso();
  const id = existing?.id ?? idFromHref(href) ?? newId();

  let allDay = false;
  let dueDate: string | null = null;
  let dueAt: string | null = null;
  if (parsed.due?.date) {
    allDay = true;
    dueDate = parsed.due.date;
  } else if (parsed.due?.instant) {
    dueAt = parsed.due.instant;
  } else if (parsed.dtstart?.date) {
    allDay = true;
    dueDate = parsed.dtstart.date;
  } else if (parsed.dtstart?.instant) {
    dueAt = parsed.dtstart.instant;
  }
  // RFC 5545 allows DTSTART + DURATION instead of DUE. Compute the deadline
  // rather than storing the start instant as the due time.
  if (!parsed.due && parsed.duration && parsed.dtstart) {
    const minutes = parseDurationMinutes(parsed.duration);
    if (minutes !== null && minutes >= 0) {
      if (parsed.dtstart.instant) {
        dueAt = new Date(
          Date.parse(parsed.dtstart.instant) + minutes * 60_000,
        ).toISOString();
      } else if (parsed.dtstart.date) {
        dueDate = new Date(
          Date.parse(`${parsed.dtstart.date}T00:00:00.000Z`) + minutes * 60_000,
        )
          .toISOString()
          .slice(0, 10);
      }
    }
  }

  const rrule = parsed.rrule
    ? /^RRULE:/i.test(parsed.rrule)
      ? parsed.rrule
      : `RRULE:${parsed.rrule.replace(/^RRULE:/i, "")}`
    : null;
  // Preserve a client DTSTART even for a one-off task (round-trip), and use
  // the 09:00 wall anchor required by the recurrence engine when recurring.
  let dtstartLocal: string | null = null;
  if (parsed.dtstart?.date) {
    dtstartLocal = rrule
      ? `${parsed.dtstart.date}T09:00:00`
      : parsed.dtstart.date;
  } else if (parsed.dtstart?.instant) {
    dtstartLocal = wallFor(parsed.dtstart.instant, tz);
  }
  if (rrule && !dtstartLocal) {
    if (dueDate) dtstartLocal = `${dueDate}T09:00:00`;
    else if (dueAt) dtstartLocal = wallFor(dueAt, tz);
  }
  if (rrule) {
    if (!dtstartLocal) {
      throw new CalDavIcsError(
        "missing_recurrence_start",
        "A recurring VTODO requires DTSTART.",
      );
    }
    try {
      assertValidRecurrence({
        rrule,
        dtstartLocal,
        timezone: tz,
        count: null,
        untilUtc: null,
        untilDate: null,
        wkst: null,
        clampPolicy: "skip",
        allDay,
        reminderTimeLocal: allDay ? "09:00:00" : null,
      });
    } catch {
      throw new CalDavIcsError(
        "invalid_recurrence",
        "RRULE is not a supported recurrence rule.",
      );
    }
  }

  const hasAlarm = parsed.alarms.length > 0;
  const relativeAlarm = parsed.alarms.find(
    (alarm) => alarm.triggerMinutes !== null,
  );
  const absoluteAlarm = parsed.alarms.find((alarm) => alarm.triggerAt !== null);
  const offset = relativeAlarm?.triggerMinutes ??
    (hasAlarm ? null : (existing?.remind_offset_minutes ?? null));
  const explicitRemindAt = absoluteAlarm
    ? absoluteAlarm.triggerAt
    : hasAlarm
      ? undefined
      : existing
        ? existing.remind_offset_minutes !== null
          ? undefined
          : (existing.remind_at ?? null)
        : null;
  const reminderTimeLocal =
    existing?.reminder_time_local ?? (allDay ? "09:00:00" : null);
  const derived = deriveReminder({
    dueAt,
    dueDate,
    allDay,
    timezone: tz,
    fallbackTimezone: tz,
    reminderTimeLocal,
    remindOffsetMinutes: offset,
    explicitRemindAt,
    rrule,
    dtstartLocal,
  });
  const remindAt = absoluteAlarm
    ? absoluteAlarm.triggerAt
    : derived.remindAt;

  const status =
    parsed.status === "COMPLETED"
      ? "done"
      : parsed.status === "CANCELLED"
        ? "cancelled"
        : "open";
  const completedAt =
    status === "done"
      ? (parsed.completed ??
        (existing?.status === "done" ? existing.completed_at : null) ??
        now)
      : null;
  const priority =
    parsed.priority !== null
      ? priorityFromIcal(parsed.priority)
      : (existing?.priority ?? 0);
  // Never move SEQUENCE/rev backwards, even if a client sends a higher value
  // than the stored revision (e.g. after an offline edit or restore).
  const nextRev = existing
    ? Math.max(existing.rev + 1, parsed.sequence ?? 0)
    : Math.max(1, parsed.sequence ?? 0);

  const values = {
    id,
    user_id: existing?.user_id ?? user.id,
    list_id: existing?.list_id ??
      (collection.kind === "list" ? collection.listId : null),
    title: parsed.summary?.trim() || existing?.title || "Untitled reminder",
    notes: parsed.description ?? existing?.notes ?? null,
    ical_uid: uid,
    caldav_href: href,
    status,
    priority,
    due_at: dueAt,
    due_date: dueDate,
    all_day: allDay ? 1 : 0,
    timezone: tz,
    remind_at: remindAt,
    reminder_time_local: reminderTimeLocal,
    remind_offset_minutes: absoluteAlarm ? null : offset,
    dtstart_local: dtstartLocal,
    next_occurrence_at: derived.nextOccurrenceAt,
    next_occurrence_local: derived.nextOccurrenceLocal,
    occurrence_seq: derived.occurrenceSeq,
    rrule,
    completed_at: completedAt,
    rev: nextRev,
    updated_at: now,
  };

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE tasks SET
           title = @title, notes = @notes, ical_uid = @ical_uid,
           caldav_href = @caldav_href, status = @status,
           priority = @priority, due_at = @due_at, due_date = @due_date,
           all_day = @all_day, timezone = @timezone, remind_at = @remind_at,
           reminder_time_local = @reminder_time_local,
           remind_offset_minutes = @remind_offset_minutes,
           dtstart_local = @dtstart_local,
           next_occurrence_at = @next_occurrence_at,
           next_occurrence_local = @next_occurrence_local,
           occurrence_seq = @occurrence_seq, rrule = @rrule,
           completed_at = @completed_at, updated_by = 'caldav',
           rev = @rev, updated_at = @updated_at
         WHERE id = @id`,
      ).run(values);
    } else {
      db.prepare(
        `INSERT INTO tasks
           (id, user_id, list_id, title, notes, ical_uid, caldav_href,
            status, priority, due_at, due_date, all_day, timezone,
            remind_at, reminder_time_local, remind_offset_minutes,
            snoozed_until, dtstart_local, next_occurrence_at,
            next_occurrence_local, occurrence_seq, rrule,
            recurrence_until_utc, recurrence_until_date, recurrence_count,
            wkst, recurrence_mode, clamp_policy, series_ended_at,
            missed_count, completed_at, sort_key, created_by, updated_by,
            rev, created_at, updated_at, deleted_at)
         VALUES
           (@id, @user_id, @list_id, @title, @notes, @ical_uid, @caldav_href,
            @status, @priority, @due_at, @due_date, @all_day, @timezone,
            @remind_at, @reminder_time_local, @remind_offset_minutes,
            NULL, @dtstart_local, @next_occurrence_at,
            @next_occurrence_local, @occurrence_seq, @rrule,
            NULL, NULL, NULL, NULL, 'schedule', 'skip', NULL, 0,
            @completed_at, @sort_key, 'caldav', 'caldav', @rev, @created_at,
            @updated_at, NULL)`,
      ).run({
        ...values,
        sort_key: initialSortKey(),
        created_at: now,
      });
    }
    // Part of the same transaction: a rejected EXDATE write must roll back the
    // base task too, and dropping an EXDATE must reopen the occurrence. ICS
    // import passes false because its parsed objects do not carry EXDATE yet;
    // reconciling there would wipe existing cancellations.
    if (reconcileExdates) {
      syncExdates(
        collection,
        { id, user_id: values.user_id },
        parsed.exdates,
        href,
      );
    }
    if (parsed.categories !== null) {
      applyCategories(user.id, id, parsed.categories, now);
    }
  });
  tx();

  const row = db
    .prepare(`SELECT ${CALDAV_TASK_COLUMNS} FROM tasks t WHERE t.id = ?`)
    .get(id) as CalTask | undefined;
  return row as CalTask;
}

function canonicalRecurrenceId(value: ParsedDateValue | null): string | null {
  if (!value) return null;
  return value.date ?? value.instant;
}

function exceptionPatchFromParsed(
  parsed: ParsedVtodo,
  base: CalTask,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (parsed.summary !== null) {
    patch["title"] = parsed.summary.trim() || base.title;
  }
  if (parsed.description !== null) patch["notes"] = parsed.description;
  if (parsed.priority !== null) {
    patch["priority"] = priorityFromIcal(parsed.priority);
  }
  let allDay = base.all_day === 1;
  let dueAt = base.due_at;
  let dueDate = base.due_date;
  if (parsed.due?.date) {
    allDay = true;
    dueDate = parsed.due.date;
    dueAt = null;
  } else if (parsed.due?.instant) {
    allDay = false;
    dueAt = parsed.due.instant;
    dueDate = null;
  } else if (parsed.dtstart?.date) {
    allDay = true;
    dueDate = parsed.dtstart.date;
    dueAt = null;
  } else if (parsed.dtstart?.instant) {
    allDay = false;
    dueAt = parsed.dtstart.instant;
    dueDate = null;
  }
  patch["dueAt"] = dueAt;
  patch["dueDate"] = dueDate;
  patch["allDay"] = allDay ? 1 : 0;
  if (parsed.dtstart?.date) {
    patch["dtstartLocal"] = parsed.dtstart.date;
  } else if (parsed.dtstart?.instant) {
    patch["dtstartLocal"] = wallFor(
      parsed.dtstart.instant,
      base.timezone ?? "UTC",
    );
  }
  return patch;
}

type StoredException = {
  id: string;
  recurrence_id: string;
  caldav_href: string;
  patch_json: string;
  status: string | null;
  ical_extra_json: string | null;
};

/**
 * An EXDATE-created cancellation is a bare cancelled exception: no client
 * patch and no extra iCalendar fields. Explicit RECURRENCE-ID overrides always
 * carry a patch (even an empty edit stores due/all-day keys), so they are
 * never removed by a client that drops an EXDATE line.
 */
function isExdateException(row: StoredException): boolean {
  return (
    row.status === "cancelled" &&
    row.patch_json === "{}" &&
    row.ical_extra_json === null
  );
}

/**
 * The base resource emits EXDATE for EXDATE-sourced cancellations. When such
 * an exception is deleted or converted to an explicit override, the base
 * representation changes too; touch the base so the journal gives sync clients
 * an update for it (not just a tombstone for the exception).
 */
function touchBaseForExdateChange(taskId: string, now: string): void {
  getDb()
    .prepare(
      "UPDATE tasks SET rev = rev + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    )
    .run(now, taskId);
}

/**
 * Journal the old href before an exception resource is renamed in place.
 * The exception update trigger writes the new href; without this tombstone a
 * sync client keeps the old resource forever.
 */
function journalExceptionRename(
  taskId: string,
  exceptionId: string,
  oldHref: string,
  now: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO caldav_changes
         (collection, user_id, task_id, href, change_type, changed_at,
          exception_id)
       SELECT
         CASE
           WHEN t.list_id IS NULL THEN 'inbox'
           WHEN EXISTS (
             SELECT 1 FROM lists l
              WHERE l.id = t.list_id AND l.is_inbox = 1
                AND l.user_id = t.user_id
           ) THEN 'inbox'
           ELSE t.list_id
         END,
         t.user_id, t.id, ?, 'delete', ?, ?
         FROM tasks t WHERE t.id = ?`,
    )
    .run(oldHref, now, exceptionId, taskId);
}

function uniqueExdateHref(
  collection: CalDavCollection,
  taskId: string,
  baseHref: string,
  recurrenceId: string,
): string {
  const stem = baseHref.replace(/\.ics$/i, "");
  const hash = crypto
    .createHash("sha1")
    .update(recurrenceId)
    .digest("hex")
    .slice(0, 10);
  const sameTask = getDb().prepare(
    `SELECT 1 AS found FROM task_recurrence_exceptions
      WHERE task_id = ? AND caldav_href = ? AND deleted_at IS NULL`,
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate =
      attempt === 0
        ? `${stem}~ex-${hash}.ics`
        : `${stem}~ex-${hash}-${attempt}.ics`;
    if (candidate === baseHref) continue;
    if (sameTask.get(taskId, candidate)) continue;
    // The exception and base namespaces share one collection. Refuse names
    // that would shadow another task or another series' exception.
    if (taskForCollectionHref(collection, candidate)) continue;
    if (exceptionResourceForHref(collection, candidate)) continue;
    return candidate;
  }
  throw new CalDavIcsError(
    "exdate_href_conflict",
    "Could not allocate a unique href for the excluded occurrence.",
    409,
    "valid-calendar-data",
  );
}

/**
 * Reconcile the base series' EXDATE set. Runs inside the caller's transaction
 * so a failed exception write cannot leave a committed base with half-applied
 * exclusions. Removing an EXDATE reopens the occurrence by soft-deleting only
 * the EXDATE-sourced exception.
 */
function syncExdates(
  collection: CalDavCollection,
  base: { id: string; user_id: string },
  exdates: ParsedDateValue[],
  baseHref: string,
): void {
  const db = getDb();
  const now = nowIso();
  const desired = new Map<string, ParsedDateValue>();
  for (const value of exdates) {
    const recurrenceId = canonicalRecurrenceId(value);
    if (recurrenceId) desired.set(recurrenceId, value);
  }
  const existing = db
    .prepare(
      `SELECT id, recurrence_id, caldav_href, patch_json, status,
              ical_extra_json
         FROM task_recurrence_exceptions
        WHERE task_id = ? AND deleted_at IS NULL`,
    )
    .all(base.id) as StoredException[];
  const byRecurrence = new Map(
    existing.map((row) => [row.recurrence_id, row]),
  );

  const remove = db.prepare(
    `UPDATE task_recurrence_exceptions
        SET deleted_at = ?, rev = rev + 1, updated_at = ?
      WHERE id = ?`,
  );
  for (const row of existing) {
    if (isExdateException(row) && !desired.has(row.recurrence_id)) {
      remove.run(now, now, row.id);
    }
  }

  const insert = db.prepare(
    `INSERT INTO task_recurrence_exceptions
       (id, task_id, user_id, recurrence_id, caldav_href, patch_json,
        status, completed_at, ical_extra_json, rev, created_at,
        updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, '{}', 'cancelled', NULL, NULL, 1, ?, ?, NULL)`,
  );
  for (const recurrenceId of desired.keys()) {
    const row = byRecurrence.get(recurrenceId);
    if (row) {
      // An explicit client override always wins over EXDATE cancellation.
      continue;
    }
    insert.run(
      newId(),
      base.id,
      base.user_id,
      recurrenceId,
      uniqueExdateHref(collection, base.id, baseHref, recurrenceId),
      now,
      now,
    );
  }
}

function liveExceptionByRecurrence(
  taskId: string,
  recurrenceId: string,
): CalDavExceptionRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM task_recurrence_exceptions
        WHERE task_id = ? AND recurrence_id = ? AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(taskId, recurrenceId) as CalDavExceptionRow | undefined;
  return row ?? null;
}

function upsertException(
  collection: CalDavCollection,
  parsed: ParsedVtodo,
  base: CalTask,
  existing: { task: CalTask; exception: CalDavExceptionRow } | null,
  href: string,
  recurrenceId: string,
): CalTask {
  const now = nowIso();
  const patch = exceptionPatchFromParsed(parsed, base);
  const status =
    parsed.status === "COMPLETED"
      ? "done"
      : parsed.status === "CANCELLED"
        ? "cancelled"
        : "open";
  const completedAt =
    status === "done"
      ? (parsed.completed ??
        (existing?.exception.completed_at ?? now))
      : null;
  const nextRev = existing
    ? Math.max(existing.exception.rev + 1, parsed.sequence ?? 0)
    : Math.max(1, parsed.sequence ?? 0);

  const db = getDb();
  const write = db.transaction(() => {
    if (existing) {
      if (existing.exception.caldav_href !== href) {
        journalExceptionRename(
          existing.exception.task_id,
          existing.exception.id,
          existing.exception.caldav_href,
          now,
        );
      }
      db.prepare(
        `UPDATE task_recurrence_exceptions
            SET recurrence_id = ?, caldav_href = ?, patch_json = ?,
                status = ?, completed_at = ?, rev = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        recurrenceId,
        href,
        JSON.stringify(patch),
        status,
        completedAt,
        nextRev,
        now,
        existing.exception.id,
      );
      if (isExdateException(existing.exception)) {
        touchBaseForExdateChange(base.id, now);
      }
    } else {
      const id = newId();
      db.prepare(
        `INSERT INTO task_recurrence_exceptions
           (id, task_id, user_id, recurrence_id, caldav_href, patch_json,
            status, completed_at, ical_extra_json, rev, created_at,
            updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
      ).run(
        id,
        base.id,
        base.user_id,
        recurrenceId,
        href,
        JSON.stringify(patch),
        status,
        completedAt,
        nextRev,
        now,
        now,
      );
    }
  });
  write();

  const fresh = exceptionResourceForHref(collection, href);
  if (fresh) return fresh.task;
  const byId = existing
    ? exceptionResourceForId(collection, existing.exception.id)
    : null;
  if (byId) return byId.task;
  throw new CalDavIcsError(
    "write_failed",
    "The recurrence exception was not persisted.",
    500,
    "valid-calendar-data",
  );
}

interface ImportTarget {
  listId: string | null;
  collection: CalDavCollection;
}

type ImportItemStatus =
  | "imported"
  | "updated"
  | "unchanged"
  | "conflict"
  | "stale"
  | "failed";

interface ImportItemResult {
  index: number;
  uid: string | null;
  status: ImportItemStatus;
  taskId?: string;
  detail?: string;
}

function inboxListRow(userId: string): { id: string } | null {
  const row = getDb()
    .prepare(
      `SELECT id FROM lists
        WHERE user_id = ? AND is_inbox = 1 AND deleted_at IS NULL
        LIMIT 1`,
    )
    .get(userId) as { id: string } | undefined;
  return row ?? null;
}

function importTarget(user: CalendarUser, requested: string | null): ImportTarget | null {
  const db = getDb();
  let listId: string | null = null;
  if (requested !== null) {
    const row = db
      .prepare(
        "SELECT id FROM lists WHERE id = ? AND deleted_at IS NULL LIMIT 1",
      )
      .get(requested) as { id: string } | undefined;
    // A missing list and an inaccessible list both return null so a member
    // cannot probe another account's list ids.
    if (!row || !canAccessList(user.id, row.id)) return null;
    listId = row.id;
  } else {
    listId = inboxListRow(user.id)?.id ?? null;
  }
  return {
    listId,
    collection: {
      key: listId ?? INBOX_COLLECTION,
      path: collectionPath(listId ?? INBOX_COLLECTION),
      name: "ICS import",
      color: null,
      kind: listId ? "list" : "inbox",
      listId,
      ownerId: user.id,
      shared: false,
      viewerId: user.id,
    },
  };
}

function taskForImportUid(
  userId: string,
  target: ImportTarget,
  uid: string,
): CalTask | null {
  const inboxId = inboxListRow(userId)?.id ?? null;
  const isInboxTarget = target.listId === null || target.listId === inboxId;
  const where = isInboxTarget
    ? inboxId
      ? "t.user_id = ? AND (t.list_id IS NULL OR t.list_id = ?)"
      : "t.user_id = ? AND t.list_id IS NULL"
    : "t.list_id = ?";
  const params = isInboxTarget
    ? inboxId
      ? [userId, inboxId]
      : [userId]
    : [target.listId];
  const row = getDb()
    .prepare(
      `SELECT ${CALDAV_TASK_COLUMNS}
         FROM tasks t
        WHERE ${where} AND t.deleted_at IS NULL
          AND (t.ical_uid = ? OR (t.ical_uid IS NULL AND t.id || '@morrow' = ?))
        LIMIT 1`,
    )
    .get(...params, uid, uid) as CalTask | undefined;
  return row ?? null;
}

function importFingerprintForTask(
  task: CalTask,
  tagNames: string[],
  fallbackTimezone: string,
): string {
  const allDay =
    task.all_day === 1 ||
    task.all_day === true ||
    (task.due_date !== null && task.due_at === null);
  let dtstartDate: string | null = null;
  let dtstartInstant: string | null = null;
  if (task.dtstart_local) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(task.dtstart_local)) {
      dtstartDate = task.dtstart_local;
    } else {
      const tz =
        task.timezone && isValidTimeZone(task.timezone)
          ? task.timezone
          : fallbackTimezone;
      try {
        dtstartInstant = resolveWallTime(task.dtstart_local, tz).instantIso;
      } catch {
        dtstartInstant = null;
      }
    }
  }
  return fingerprintParts({
    summary: task.title,
    description: task.notes,
    dueDate: allDay ? task.due_date : task.due_at ? null : task.due_date,
    dueInstant: allDay ? null : task.due_at,
    dtstartDate,
    dtstartInstant,
    status: task.status,
    completed: task.completed_at,
    priority: task.priority,
    categories: tagNames,
    rrule: task.rrule,
    alarmRelative:
      task.remind_offset_minutes !== null
        ? task.remind_offset_minutes
        : null,
    alarmAbsolute:
      task.remind_offset_minutes === null ? task.remind_at : null,
  });
}

function importedAsParsedVtodo(
  object: ImportedIcsObject,
  uid: string,
): ParsedVtodo {
  return {
    component: "VTODO",
    method: null,
    uid,
    summary: object.summary,
    description: object.description,
    due: object.due,
    dtstart: object.dtstart,
    duration: null,
    status: object.status,
    completed: object.completed,
    priority: object.priority,
    categories: object.categories,
    sequence: object.sequence,
    rrule: object.rrule,
    recurrenceId: null,
    recurrenceRange: null,
    exdates: [],
    alarms: object.alarms,
  };
}

function safeTagNames(userId: string, taskId: string): string[] {
  return tagsForTask(userId, taskId).map((tag) => tag.name);
}

/**
 * Import one parsed object into a target list. Returns no-throw outcomes so
 * one bad/conflicting object never stops the rest of the file.
 */
function importOneObject(
  user: CalendarUser,
  target: ImportTarget,
  object: ImportedIcsObject,
): ImportItemResult {
  const uid = object.uid?.trim() || null;
  const existing = uid ? taskForImportUid(user.id, target, uid) : null;
  if (existing) {
    if (object.sequence < existing.rev) {
      return {
        index: object.index,
        uid,
        status: "stale",
        taskId: existing.id,
        detail: `SEQUENCE ${object.sequence} is older than the stored ${existing.rev}; left unchanged.`,
      };
    }
    if (object.sequence === existing.rev) {
      const same =
        importFingerprint(object) ===
        importFingerprintForTask(
          existing,
          safeTagNames(user.id, existing.id),
          isValidTimeZone(user.timezone) ? user.timezone : "UTC",
        );
      if (same) {
        return {
          index: object.index,
          uid,
          status: "unchanged",
          taskId: existing.id,
        };
      }
      return {
        index: object.index,
        uid,
        status: "conflict",
        taskId: existing.id,
        detail: `Equal SEQUENCE ${object.sequence} but different content; resolve the conflict before importing again.`,
      };
    }
  }

  const id = existing?.id ?? newId();
  const href = existing ? caldavHrefFor(existing) : `${id}.ics`;
  const finalUid = uid ?? `${id}@morrow`;
  const parsed = importedAsParsedVtodo(object, finalUid);
  try {
    const task = upsertTask(
      user,
      target.collection,
      parsed,
      existing,
      href,
      finalUid,
      false,
    );
    return {
      index: object.index,
      uid: finalUid,
      status: existing ? "updated" : "imported",
      taskId: task.id,
    };
  } catch (err) {
    return {
      index: object.index,
      uid: finalUid,
      status: "failed",
      detail: err instanceof Error ? err.message : "Import failed.",
    };
  }
}

function importIcsInto(
  user: CalendarUser,
  target: ImportTarget,
  objects: ImportedIcsObject[],
): { results: ImportItemResult[]; counts: Record<ImportItemStatus, number> } {
  const results: ImportItemResult[] = [];
  const counts: Record<ImportItemStatus, number> = {
    imported: 0,
    updated: 0,
    unchanged: 0,
    conflict: 0,
    stale: 0,
    failed: 0,
  };
  for (const object of objects) {
    const result = importOneObject(user, target, object);
    counts[result.status] += 1;
    results.push(result);
  }
  return { results, counts };
}

// ---------------------------------------------------------------------------
// DAV XML
// ---------------------------------------------------------------------------

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function responseBlock(href: string, props: string): string {
  return `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function notFoundBlock(href: string): string {
  return `<d:response><d:href>${xmlEscape(href)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
}

function calendarDataBlock(href: string, etag: string, data: string): string {
  return `<d:response><d:href>${xmlEscape(href)}</d:href><d:propstat><d:prop><d:getetag>${xmlEscape(etag)}</d:getetag><cal:calendar-data>${xmlEscape(data)}</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function multistatus(blocks: string[], syncToken?: string): string {
  const token = syncToken
    ? `<d:sync-token>${xmlEscape(syncToken)}</d:sync-token>`
    : "";
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/">${blocks.join("")}${token}</d:multistatus>`;
}

function caldavError(
  reply: FastifyReply,
  status: number,
  precondition: string,
  detail?: string,
): FastifyReply {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><cal:${precondition}/>${
    detail ? `<d:responsedescription>${xmlEscape(detail)}</d:responsedescription>` : ""
  }</d:error>`;
  return reply
    .code(status)
    .header("content-type", "application/xml; charset=utf-8")
    .send(body);
}

/** DAV-namespace error (for example `valid-sync-token`). */
function davError(
  reply: FastifyReply,
  status: number,
  precondition: string,
  detail?: string,
): FastifyReply {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:"><d:${precondition}/>${
    detail ? `<d:responsedescription>${xmlEscape(detail)}</d:responsedescription>` : ""
  }</d:error>`;
  return reply
    .code(status)
    .header("content-type", "application/xml; charset=utf-8")
    .send(body);
}

function uidConflict(
  reply: FastifyReply,
  existingHref: string,
): FastifyReply {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><cal:no-uid-conflict><d:href>${xmlEscape(existingHref)}</d:href></cal:no-uid-conflict></d:error>`;
  return reply
    .code(409)
    .header("content-type", "application/xml; charset=utf-8")
    .header("location", existingHref)
    .send(body);
}

function collectionProps(collection: CalDavCollection): string {
  const props = [
    `<d:displayname>${xmlEscape(collection.name)}</d:displayname>`,
    "<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>",
    '<cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>',
    '<d:supported-report-set><d:supported-report><d:report><cal:calendar-query/></d:report></d:supported-report><d:supported-report><d:report><cal:calendar-multiget/></d:report></d:supported-report><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report></d:supported-report-set>',
    `<cs:getctag>${changeTokenFor(collection.viewerId, collection.key)}</cs:getctag>`,
    `<d:sync-token>${xmlEscape(syncTokenFor(getDb(), collection.viewerId, collection.key))}</d:sync-token>`,
    `<cal:calendar-description>${xmlEscape(collection.name)}</cal:calendar-description>`,
  ];
  if (collection.color) {
    props.push(
      `<ical:calendar-color>${xmlEscape(collection.color)}</ical:calendar-color>`,
    );
  }
  return props.join("");
}

function principalProps(user: CalendarUser): string {
  return [
    `<d:displayname>${xmlEscape(user.username)}</d:displayname>`,
    "<d:resourcetype><d:collection/><d:principal/></d:resourcetype>",
    "<d:current-user-principal><d:href>/caldav/principal/</d:href></d:current-user-principal>",
    '<cal:calendar-home-set><d:href>/caldav/calendars/</d:href></cal:calendar-home-set>',
    '<cal:calendar-user-address-set><d:href>mailto:morrow@localhost</d:href></cal:calendar-user-address-set>',
  ].join("");
}

function resourceProps(etag: string): string {
  return `<d:getetag>${xmlEscape(etag)}</d:getetag><d:getcontenttype>text/calendar; component=VTODO</d:getcontenttype><d:resourcetype/>`;
}

function collectionResourceBlock(
  task: CalTask,
  etag: string,
  collection: CalDavCollection,
): string {
  return responseBlock(resourceHref(collection, task), resourceProps(etag));
}

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------

function report(
  root: string,
  body: string,
): { multiget: boolean; query: boolean; sync: boolean } {
  const multiget = /<(?:[A-Za-z0-9_-]+:)?calendar-multiget\b/i.test(root);
  const query = /<(?:[A-Za-z0-9_-]+:)?calendar-query\b/i.test(root);
  const sync = /<(?:[A-Za-z0-9_-]+:)?sync-collection\b/i.test(root);
  return { multiget, query, sync };
}

function extractHrefs(body: string): string[] {
  const hrefs: string[] = [];
  const re =
    /<(?:[A-Za-z0-9_-]+:)?href[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?href>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    hrefs.push(xmlUnescape(match[1] as string).trim());
  }
  return hrefs;
}

function hrefPath(raw: string): string {
  let value = raw.trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      return "";
    }
  }
  const cut = value.search(/[?#]/);
  return cut >= 0 ? value.slice(0, cut) : value;
}

function unsupportedFilterPrecondition(body: string): string | null {
  if (/<(?:[A-Za-z0-9_-]+:)?(time-range|prop-filter|param-filter|text-match|is-not-defined)\b/i.test(body)) {
    return "supported-filter";
  }
  return null;
}

function componentFilters(body: string): string[] {
  const names: string[] = [];
  const re =
    /<(?:[A-Za-z0-9_-]+:)?comp-filter\b[^>]*\bname="([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    names.push((match[1] as string).trim().toUpperCase());
  }
  return names;
}

function syncTokenFromBody(body: string): string | null {
  const match =
    /<(?:[A-Za-z0-9_-]+:)?sync-token[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?sync-token>/i.exec(
      body,
    );
  if (!match) return null;
  return xmlUnescape((match[1] as string).trim());
}

function syncLevelFromBody(body: string): string | null {
  const match =
    /<(?:[A-Za-z0-9_-]+:)?sync-level[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?sync-level>/i.exec(
      body,
    );
  return match ? (match[1] as string).trim().toLowerCase() : null;
}

function syncResourceBlock(
  collection: CalDavCollection,
  task: CalTask,
  etag: string,
  includeData: boolean,
  tags: CalDavTag[],
): string {
  const data = includeData
    ? `<cal:calendar-data>${xmlEscape(calendarObjectForTask(task, tags))}</cal:calendar-data>`
    : "";
  return `<d:response><d:href>${xmlEscape(resourceHref(collection, task))}</d:href><d:propstat><d:prop><d:getetag>${xmlEscape(etag)}</d:getetag>${data}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function syncTombstoneBlock(
  collection: CalDavCollection,
  href: string,
): string {
  return `<d:response><d:href>${xmlEscape(resourceHrefFor(collection, href))}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
}

function handleSyncCollection(
  _req: FastifyRequest,
  reply: FastifyReply,
  user: CalendarUser,
  collection: CalDavCollection,
  body: string,
): FastifyReply {
  const db = getDb();
  // Journal retention runs in the scheduler tick, not on this read path:
  // REPORT must not write during a live restore, and pruning before token
  // validation made an otherwise valid sync do the cleanup itself.
  const level = syncLevelFromBody(body);
  if (level !== null && level !== "1" && level !== "infinite") {
    return davError(
      reply,
      403,
      "supported-sync-level",
      "This collection supports sync-level 1 and infinite only.",
    );
  }

  const includeData = /<(?:[A-Za-z0-9_-]+:)?calendar-data\b/i.test(body);
  const rawToken = syncTokenFromBody(body)?.trim() ?? "";

  // Empty/missing token: initial synchronization returns the full collection.
  if (rawToken === "") {
    const tasks = resourcesForCollection(collection, true);
    const tags = tagsForUserTasks(user.id);
    const blocks = tasks.map((task) => {
      const taskTags = tags.get(task.id) ?? [];
      return syncResourceBlock(
        collection,
        task,
        etagFor(task, taskTags),
        includeData,
        taskTags,
      );
    });
    return reply
      .code(207)
      .header("content-type", "application/xml; charset=utf-8")
      .send(multistatus(blocks, syncTokenFor(db, user.id, collection.key)));
  }

  const token = parseSyncToken(rawToken);
  if (
    !token ||
    !isUsableSyncToken(db, user.id, token, collection.key)
  ) {
    return davError(
      reply,
      403,
      "valid-sync-token",
      "The sync token is expired or unknown; perform a full sync.",
    );
  }

  const changes = changesSinceCollection(
    db,
    user.id,
    collection.key,
    token.seq,
  );
  const latest = new Map<string, CalDavChangeRow>();
  const deletedHrefs = new Map<string, Set<string>>();
  for (const change of changes) {
    const key = change.exception_id ?? change.task_id;
    latest.set(key, change);
    if (change.change_type === "delete") {
      const set = deletedHrefs.get(key) ?? new Set<string>();
      set.add(change.href);
      deletedHrefs.set(key, set);
    }
  }

  const tags = tagsForUserTasks(user.id);
  const blocks: string[] = [];
  for (const [resourceKey, change] of latest) {
    const task =
      change.change_type === "delete"
        ? null
        : change.exception_id
          ? (exceptionResourceForId(collection, change.exception_id)?.task ??
            null)
          : taskForCollectionId(collection, change.task_id);
    const emitted = new Set<string>();
    const tombstone = (href: string) => {
      if (emitted.has(href)) return;
      emitted.add(href);
      blocks.push(syncTombstoneBlock(collection, href));
    };
    const previousDeletes = deletedHrefs.get(resourceKey) ?? new Set<string>();

    if (!task) {
      tombstone(change.href);
      for (const href of previousDeletes) tombstone(href);
      continue;
    }

    // A same-collection rename produces delete@old + update@new. The latest
    // row wins for the resource, but the old href still needs a tombstone so
    // the client does not keep a phantom resource.
    const currentHref = caldavHrefFor(task);
    for (const href of previousDeletes) {
      if (href !== currentHref) tombstone(href);
    }

    const taskTags = tags.get(task.id) ?? [];
    blocks.push(
      syncResourceBlock(
        collection,
        task,
        etagFor(task, taskTags),
        includeData,
        taskTags,
      ),
    );
  }

  return reply
    .code(207)
    .header("content-type", "application/xml; charset=utf-8")
    .send(multistatus(blocks, syncTokenFor(db, user.id, collection.key)));
}

function handleReport(
  req: FastifyRequest,
  reply: FastifyReply,
  user: CalendarUser,
  collection: CalDavCollection,
  body: string,
): FastifyReply {
  const root = body.match(
    /<(?:[A-Za-z0-9_-]+:)?(calendar-multiget|calendar-query|sync-collection)\b/i,
  );
  const kind = report(root?.[0] ?? "", body);
  if (!kind.multiget && !kind.query && !kind.sync) {
    return caldavError(reply, 403, "supported-report", "Unsupported REPORT.");
  }

  if (kind.sync) {
    return handleSyncCollection(req, reply, user, collection, body);
  }

  if (kind.multiget) {
    const tags = tagsForUserTasks(user.id);
    const blocks: string[] = [];
    for (const rawHref of extractHrefs(body)) {
      const path = hrefPath(rawHref);
      const requestedHref = path || rawHref;
      const href = path.startsWith(collection.path)
        ? normalizeHref(path.slice(collection.path.length))
        : null;
      const resource = href ? resourceForCollectionHref(collection, href) : null;
      const task = resource?.task ?? null;
      if (!task) {
        blocks.push(notFoundBlock(requestedHref));
        continue;
      }
      const taskTags = tags.get(task.id) ?? [];
      blocks.push(
        calendarDataBlock(
          resourceHref(collection, task),
          etagFor(task, taskTags),
          calendarObjectForTask(task, taskTags),
        ),
      );
    }
    return reply
      .code(207)
      .header("content-type", "application/xml; charset=utf-8")
      .send(multistatus(blocks));
  }

  const unsupported = unsupportedFilterPrecondition(body);
  if (unsupported) {
    return caldavError(
      reply,
      403,
      unsupported,
      "This release supports comp-filter VCALENDAR/VTODO only.",
    );
  }
  const components = componentFilters(body);
  if (components.includes("VEVENT")) {
    return caldavError(
      reply,
      403,
      "supported-calendar-component",
      "The CalDAV collection exposes VTODO only; use /api/calendar.ics for events.",
    );
  }
  if (
    components.some(
      (name) => name !== "VCALENDAR" && name !== "VTODO",
    )
  ) {
    return caldavError(
      reply,
      403,
      "supported-filter",
      "Unsupported component filter.",
    );
  }

  const tasks = resourcesForCollection(collection, true);
  const tags = tagsForUserTasks(user.id);
  return reply
    .code(207)
    .header("content-type", "application/xml; charset=utf-8")
    .send(
      multistatus(
        tasks.map((task) => {
          const taskTags = tags.get(task.id) ?? [];
          return calendarDataBlock(
            resourceHref(collection, task),
            etagFor(task, taskTags),
            calendarObjectForTask(task, taskTags),
          );
        }),
      ),
    );
}

function handleMkcalendar(
  req: FastifyRequest,
  reply: FastifyReply,
  user: CalendarUser,
  key: string,
): FastifyReply {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
    return reply.code(400).send();
  }
  if (key === LEGACY_COLLECTION || key === INBOX_COLLECTION) {
    return reply.code(405).send();
  }
  if (listRowById(key)) return reply.code(405).send();

  const body = String(req.body ?? "");
  const name = (xmlTextProperty(body, "displayname") ?? key)
    .trim()
    .slice(0, 200);
  if (!name) return reply.code(400).send();
  const colorRaw = xmlTextProperty(body, "calendar-color");
  const color = colorRaw ? colorRaw.slice(0, 32) : null;
  const now = nowIso();

  const tx = getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO lists
           (id, user_id, name, color, icon, sort_key, is_inbox,
            created_by, updated_by, rev, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, NULL, ?, 0, 'caldav', 'caldav', 1, ?, ?, NULL)`,
      )
      .run(key, user.id, name, color, initialSortKey(), now, now);
    const after = listRowById(key);
    writeListActivity(
      user.id,
      "list.create",
      key,
      null,
      after,
      `created list "${name}" via CalDAV`,
    );
  });
  tx();
  return reply.code(201).send();
}

function handleProppatch(
  req: FastifyRequest,
  reply: FastifyReply,
  user: CalendarUser,
  collection: CalDavCollection,
): FastifyReply {
  if (collection.kind !== "list" || collection.ownerId !== user.id) {
    return reply.code(403).send();
  }
  const listId = collection.listId as string;
  const before = listRowById(listId);
  if (!before || before["deleted_at"] != null) return reply.code(404).send();

  const body = String(req.body ?? "");
  const name = xmlTextProperty(body, "displayname");
  const colorPresent = /<(?:[A-Za-z0-9_-]+:)?calendar-color\b/i.test(body);
  if (name === null && !colorPresent) {
    return davError(
      reply,
      403,
      "cannot-modify-protected-property",
      "Only displayname and calendar-color are writable.",
    );
  }
  const nextName = (name ?? String(before["name"] ?? "")).trim().slice(0, 200);
  if (!nextName) return reply.code(400).send();
  const nextColor = colorPresent
    ? (xmlTextProperty(body, "calendar-color") ?? "").slice(0, 32) || null
    : ((before["color"] as string | null) ?? null);
  const now = nowIso();
  getDb()
    .prepare(
      `UPDATE lists
          SET name = ?, color = ?, rev = rev + 1, updated_by = 'caldav',
              updated_at = ?
        WHERE id = ?`,
    )
    .run(nextName, nextColor, now, listId);
  const after = listRowById(listId);
  writeListActivity(
    user.id,
    "list.update",
    listId,
    before,
    after,
    `updated list "${nextName}" via CalDAV`,
  );

  const propXml = [
    name !== null ? "<d:displayname/>" : "",
    colorPresent ? "<ical:calendar-color/>" : "",
  ].join("");
  return reply
    .code(207)
    .header("content-type", "application/xml; charset=utf-8")
    .send(
      multistatus([
        `<d:response><d:href>${xmlEscape(collection.path)}</d:href><d:propstat><d:prop>${propXml}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
      ]),
    );
}

function handleCollectionDelete(
  reply: FastifyReply,
  user: CalendarUser,
  collection: CalDavCollection,
): FastifyReply {
  if (collection.kind !== "list" || collection.ownerId !== user.id) {
    return reply.code(403).send();
  }
  const listId = collection.listId as string;
  const before = listRowById(listId);
  if (!before || before["deleted_at"] != null) return reply.code(404).send();

  // See lists.ts: unlinking members into the Inbox must not collide with a
  // live UID/href already there. CalDAV clients get a proper precondition so
  // they can resolve the duplicate rather than seeing an opaque 500.
  const identityConflicts = findInboxIdentityConflicts(listId);
  if (identityConflicts.length > 0) {
    const conflict = identityConflicts[0]!;
    return davError(
      reply,
      409,
      "no-uid-conflict",
      `Task ${conflict.taskId} uses ${conflict.field} "${conflict.value}", which is already live in the Inbox (${conflict.existingHref}). Resolve the duplicate before deleting this collection.`,
    );
  }

  const db = getDb();
  const now = nowIso();
  const memberTaskIds = (
    db
      .prepare("SELECT id FROM tasks WHERE list_id = ?")
      .all(listId) as Array<{ id: string }>
  ).map((row) => row.id);

  const tx = db.transaction(() => {
    // Mirror REST list delete: member tasks survive as Inbox tasks.
    db.prepare(
      "UPDATE tasks SET list_id = NULL, updated_at = ? WHERE list_id = ?",
    ).run(now, listId);
    cancelPendingDeliveriesForTaskIds(db, memberTaskIds, new Date(now));
    db.prepare(
      `UPDATE lists
          SET deleted_at = ?, updated_by = 'caldav', rev = rev + 1,
              updated_at = ?
        WHERE id = ?`,
    ).run(now, now, listId);
    const after = listRowById(listId);
    writeListActivity(
      user.id,
      "list.delete",
      listId,
      { ...before, memberTaskIds },
      after,
      `deleted list "${String(before["name"] ?? "")}" via CalDAV (${memberTaskIds.length} tasks moved to Inbox)`,
    );
  });
  tx();
  return reply.code(204).send();
}

function destinationDavPath(
  raw: string | undefined,
): { collectionKey: string; href: string } | null {
  if (!raw) return null;
  let path = raw.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  if (!path.startsWith("/caldav/")) return null;
  const parsed = parseDavPath(path.slice("/caldav".length));
  if (!parsed || parsed === "home" || parsed.href === null) return null;
  return { collectionKey: parsed.collectionKey, href: parsed.href };
}

function handleMove(
  req: FastifyRequest,
  reply: FastifyReply,
  user: CalendarUser,
  source: CalDavCollection,
  href: string,
): FastifyReply {
  // The legacy all-tasks alias has one flat href namespace, so a write there
  // can address an arbitrary row when duplicate hrefs exist across lists.
  if (source.kind === "all") {
    return sendProblem(req, reply, 403, "Forbidden", {
      detail:
        "The legacy /caldav/calendars/morrow/ collection is read-only. Move tasks through their per-list collection.",
      code: "legacy_collection_read_only",
    });
  }

  const resource = resourceForCollectionHref(source, href);
  if (!resource) return reply.code(404).send();
  if (resource.exception) {
    // Exceptions are occurrence overrides of the base series. Moving one on
    // its own has no meaning: both sides must stay in the same collection.
    return davError(
      reply,
      409,
      "recurrence-id-move",
      "Recurrence exceptions cannot be moved independently. Move the base series instead.",
    );
  }
  const task = resource.task;
  // Task ownership is separate from list access: shared members can edit a
  // task in place, but only the creator may move it to another collection.
  // In particular this keeps a member from moving a shared task into what
  // would become the creator's Inbox (or their own) with confusing ownership.
  if (task.user_id !== user.id) {
    return sendProblem(req, reply, 403, "Forbidden", {
      detail: "Only the task owner can move a task between collections.",
      code: "task_owner_required",
    });
  }
  if (
    !checkWritePreconditions(
      req,
      reply,
      etagFor(task, tagsForTask(user.id, task.id)),
    )
  ) {
    return reply;
  }
  const destination = destinationDavPath(
    req.headers.destination as string | undefined,
  );
  if (!destination) return reply.code(400).send();
  const target = collectionByKey(user.id, destination.collectionKey);
  if (!target) return reply.code(404).send();
  // The legacy all-tasks alias is not a real list and cannot be a MOVE target.
  if (target.kind === "all") {
    return sendProblem(req, reply, 403, "Forbidden", {
      detail:
        "The legacy /caldav/calendars/morrow/ collection is read-only and cannot be a MOVE destination.",
      code: "legacy_collection_read_only",
    });
  }

  const occupied = taskForCollectionHref(target, destination.href);
  if (occupied && occupied.id !== task.id) {
    return reply.code(412).send();
  }
  // A base resource must not take an exception's href: CalDAV clients treat
  // the two namespaces as one collection and would see duplicate resources.
  if (exceptionResourceForHref(target, destination.href)) {
    return davError(
      reply,
      409,
      "no-uid-conflict",
      "The destination href is already used by a recurrence exception.",
    );
  }
  const uid = icalUidFor(task);
  const byUid = taskForCollectionUid(target, uid);
  if (byUid && byUid.id !== task.id) {
    return uidConflict(reply, resourceHref(target, byUid));
  }
  // The series' exception resources travel with it (their hrefs are stable).
  // Reject a move that would create duplicate hrefs or shadow another task in
  // the target collection. Own exceptions in the same collection are fine.
  const movingExceptions = getDb()
    .prepare(
      `SELECT caldav_href FROM task_recurrence_exceptions
        WHERE task_id = ? AND deleted_at IS NULL`,
    )
    .all(task.id) as Array<{ caldav_href: string }>;
  for (const exception of movingExceptions) {
    if (exception.caldav_href === destination.href) {
      return davError(
        reply,
        409,
        "no-uid-conflict",
        `The destination href is also used by an exception of this series (${exception.caldav_href}).`,
      );
    }
    if (taskForCollectionHref(target, exception.caldav_href)) {
      return davError(
        reply,
        409,
        "no-uid-conflict",
        `Moving this series would collide with a task at ${exception.caldav_href} in the target collection.`,
      );
    }
    const existingException = exceptionResourceForHref(
      target,
      exception.caldav_href,
    );
    if (existingException && existingException.task.id !== task.id) {
      return davError(
        reply,
        409,
        "no-uid-conflict",
        `Moving this series would collide with another series' exception at ${exception.caldav_href}.`,
      );
    }
  }

  const now = nowIso();
  const listId = target.kind === "list" ? target.listId : null;
  getDb()
    .prepare(
      `UPDATE tasks
          SET list_id = ?, caldav_href = ?, rev = rev + 1,
              updated_at = ?, updated_by = 'caldav'
        WHERE id = ?`,
    )
    .run(listId, destination.href, now, task.id);
  return reply.code(204).send();
}

export async function registerCalendarRoutes(app: FastifyInstance): Promise<void> {
  // WebDAV methods outside Node's built-in list.
  app.addHttpMethod("MKCALENDAR", { hasBody: true });
  app.addHttpMethod("PROPPATCH", { hasBody: true });
  app.addHttpMethod("MOVE");

  // RFC 6764 discovery starts at the well-known URI. Real clients send GET
  // and PROPFIND; both redirect to the calendar context path.
  app.route({
    method: ["GET", "PROPFIND"],
    url: "/.well-known/caldav",
    handler: async (_req, reply) =>
      reply.code(301).header("location", "/caldav/").send(),
  });

  /**
   * Authenticated file import. Raw `text/calendar` (optional `?listId=`) or
   * JSON `{ ics, listId? }`. The target defaults to the user's Inbox and must
   * be owned by or shared with the authenticated user.
   */
  app.post(
    "/api/import/ics",
    { bodyLimit: MAX_ICS_BYTES * 3 + 64 * 1024 },
    async (req, reply) => {
      const auth = requireAuth(req, reply);
      if (!auth) return reply;
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      const query = req.query as { listId?: string } | undefined;
      let ics: string;
      let requestedList: string | null = null;

      if (contentType.includes("application/json")) {
        const body = req.body as { ics?: unknown; listId?: unknown } | null;
        if (!body || typeof body.ics !== "string" || body.ics.trim() === "") {
          return badRequest(
            req,
            reply,
            "JSON import bodies must include a non-empty ics string.",
            "invalid_import",
          );
        }
        if (body.listId !== undefined && body.listId !== null) {
          if (typeof body.listId !== "string" || body.listId.trim() === "") {
            return badRequest(
              req,
              reply,
              "listId must be a non-empty string.",
              "invalid_import",
            );
          }
          requestedList = body.listId.trim();
        }
        ics = body.ics;
      } else if (
        contentType === "" ||
        contentType.includes("text/calendar") ||
        contentType.includes("text/plain") ||
        contentType.includes("application/octet-stream")
      ) {
        if (typeof req.body !== "string") {
          return badRequest(
            req,
            reply,
            "Raw imports must use text/calendar.",
            "invalid_import",
          );
        }
        ics = req.body;
        requestedList = query?.listId?.trim() || null;
      } else {
        return sendProblem(req, reply, 415, "Unsupported Media Type", {
          detail: "Send text/calendar or application/json { ics }.",
          code: "unsupported_media_type",
        });
      }

      if (Buffer.byteLength(ics, "utf8") > MAX_ICS_BYTES) {
        return sendProblem(req, reply, 413, "Payload Too Large", {
          detail: `A calendar file may be at most ${MAX_ICS_BYTES} bytes.`,
          code: "ics_too_large",
        });
      }

      const target = importTarget(auth.user, requestedList);
      if (!target) {
        return notFound(
          req,
          reply,
          "list_not_found",
          "The target list does not exist or is not accessible.",
        );
      }

      let file;
      try {
        file = parseIcsFile(ics);
      } catch (err) {
        if (err instanceof CalDavIcsError) {
          return sendProblem(req, reply, err.status, "Invalid Calendar File", {
            detail: err.message,
            code: err.code,
          });
        }
        throw err;
      }

      if (file.objects.length === 0 && file.failures.length === 0) {
        return badRequest(
          req,
          reply,
          "The calendar file contains no VTODO or VEVENT components.",
          "no_importable_objects",
        );
      }

      const { results, counts } = importIcsInto(auth.user, target, file.objects);
      const itemFailures = [
        ...file.failures,
        ...results
          .filter((result) => result.status === "failed")
          .map((result) => ({
            index: result.index,
            uid: result.uid,
            code: "import_failed",
            detail: result.detail ?? "Import failed.",
          })),
      ];
      return reply.code(200).send({
        ok: itemFailures.length === 0 && counts.conflict === 0,
        target: { listId: target.listId },
        totals: {
          ...counts,
          failed: itemFailures.length,
          ignored: file.ignored,
          components:
            file.objects.length + file.failures.length + file.ignored,
        },
        results,
        failures: itemFailures,
      });
    },
  );

  app.get("/api/calendar.ics", async (req, reply) => {
    const query = req.query as { token?: string } | undefined;
    const user = requireUser(req, reply, query?.token);
    if (!user) return reply;
    const body = calendarForTasks(tasksOwnedByUser(user.id, false));
    return reply
      .header("content-type", 'text/calendar; charset="utf-8"')
      .header("content-disposition", 'attachment; filename="morrow.ics"')
      .send(body);
  });

  app.get("/api/tasks.ics", async (req, reply) => {
    const query = req.query as { token?: string } | undefined;
    const user = requireUser(req, reply, query?.token);
    if (!user) return reply;
    const tags = tagsForUserTasks(user.id);
    const body = vtodoFeed(
      tasksOwnedByUser(user.id, true).map((task) => ({
        task,
        tags: tags.get(task.id) ?? [],
      })),
      "Morrow tasks",
    );
    return reply
      .header("content-type", 'text/calendar; charset="utf-8"')
      .header("content-disposition", 'attachment; filename="morrow-tasks.ics"')
      .send(body);
  });

  app.get("/caldav/attachments/:id", async (req, reply) => {
    const user = requestUser(req);
    if (!user) return challenge(req, reply);
    const id = (req.params as { id?: string }).id ?? "";
    const row = attachmentRowById(id);
    if (
      !row ||
      row.deleted_at !== null ||
      !canAccessTask(user.id, row.task_id)
    ) {
      return reply.code(404).send();
    }
    const filePath = safeAttachmentPath(row.storage_path);
    if (!filePath) return reply.code(404).send();
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return reply.code(404).send();
    } catch {
      return reply.code(404).send();
    }
    return reply
      .header("content-type", row.mime_type || "application/octet-stream")
      .header("content-length", String(row.bytes))
      .header(
        "content-disposition",
        contentDispositionFilename(row.filename),
      )
      .header("x-content-type-options", "nosniff")
      .send(fs.createReadStream(filePath));
  });

  app.route({
    method: [
      "OPTIONS",
      "PROPFIND",
      "REPORT",
      "GET",
      "PUT",
      "DELETE",
      "MKCALENDAR",
      "PROPPATCH",
      "MOVE",
    ],
    url: "/caldav/*",
    async handler(req, reply) {
      reply.header("DAV", "1, calendar-access");
      reply.header("MS-Author-Via", "DAV");
      if (req.method === "OPTIONS") {
        return reply
          .header(
            "Allow",
            "OPTIONS, GET, PROPFIND, REPORT, PUT, DELETE, MKCALENDAR, PROPPATCH, MOVE",
          )
          .code(200)
          .send();
      }
      const user = requestUser(req);
      if (!user) return challenge(req, reply);
      const params = req.params as { "*"?: string };
      const path = `/${params["*"] ?? ""}`;
      const normalized = path.replace(/\/+/g, "/");
      const depth = String(req.headers.depth ?? "0");
      const collectionContentType =
        "<d:getcontenttype>text/calendar; component=VTODO</d:getcontenttype>";

      if (normalized === "/" || normalized === "") {
        if (req.method !== "PROPFIND") return reply.code(405).send();
        return reply
          .code(207)
          .header("content-type", "application/xml; charset=utf-8")
          .send(
            multistatus([
              responseBlock(
                "/caldav/",
                principalProps(user) +
                  "<d:displayname>Morrow CalDAV</d:displayname>",
              ),
            ]),
          );
      }
      if (normalized === "/principal/" || normalized === "/principal") {
        if (req.method !== "PROPFIND") return reply.code(405).send();
        return reply
          .code(207)
          .header("content-type", "application/xml; charset=utf-8")
          .send(
            multistatus([
              responseBlock("/caldav/principal/", principalProps(user)),
            ]),
          );
      }

      const davPath = parseDavPath(normalized);
      if (davPath === null) return reply.code(404).send();

      if (
        davPath !== "home" &&
        req.method === "MKCALENDAR"
      ) {
        if (davPath.href !== null) return reply.code(405).send();
        return handleMkcalendar(req, reply, user, davPath.collectionKey);
      }

      if (davPath === "home") {
        if (req.method !== "PROPFIND") return reply.code(405).send();
        const blocks = [
          responseBlock(
            CALDAV_CALENDARS,
            "<d:displayname>Morrow calendars</d:displayname>" +
              "<d:resourcetype><d:collection/></d:resourcetype>",
          ),
        ];
        if (depth !== "0") {
          for (const collection of collectionsForUser(user.id)) {
            blocks.push(
              responseBlock(
                collection.path,
                collectionProps(collection) + collectionContentType,
              ),
            );
          }
        }
        return reply
          .code(207)
          .header("content-type", "application/xml; charset=utf-8")
          .send(multistatus(blocks));
      }

      const collection = collectionByKey(user.id, davPath.collectionKey);
      if (!collection) return reply.code(404).send();

      // The legacy all-tasks alias has one flat href namespace across every
      // list. Writes there can resolve a duplicate href to the wrong row, so
      // it stays readable for migration but all mutations use per-list
      // collections (or the virtual Inbox).
      if (
        collection.kind === "all" &&
        ["PUT", "DELETE", "MOVE", "PROPPATCH"].includes(req.method)
      ) {
        return sendProblem(req, reply, 403, "Forbidden", {
          detail:
            "The legacy /caldav/calendars/morrow/ collection is read-only. Use a per-list collection or /caldav/calendars/inbox/ for writes.",
          code: "legacy_collection_read_only",
        });
      }

      if (davPath.href === null) {
        if (req.method === "PROPPATCH") {
          return handleProppatch(req, reply, user, collection);
        }
        if (req.method === "DELETE") {
          return handleCollectionDelete(reply, user, collection);
        }
        if (req.method === "REPORT") {
          return handleReport(
            req,
            reply,
            user,
            collection,
            String(req.body ?? ""),
          );
        }
        if (req.method !== "PROPFIND") return reply.code(405).send();
        const blocks = [
          responseBlock(
            collection.path,
            collectionProps(collection) + collectionContentType,
          ),
        ];
        if (depth !== "0") {
          const tasks = resourcesForCollection(collection, true);
          const tags = tagsForUserTasks(user.id);
          for (const task of tasks) {
            blocks.push(
              collectionResourceBlock(
                task,
                etagFor(task, tags.get(task.id) ?? []),
                collection,
              ),
            );
          }
        }
        return reply
          .code(207)
          .header("content-type", "application/xml; charset=utf-8")
          .send(multistatus(blocks));
      }

      const href = davPath.href;
      if (req.method === "MOVE") {
        return handleMove(req, reply, user, collection, href);
      }
      if (req.method === "GET") {
        const resource = resourceForCollectionHref(collection, href);
        const task = resource?.task ?? null;
        if (!task) return reply.code(404).send();
        const tags = tagsForTask(user.id, task.id);
        const etag = etagFor(task, tags);
        const ifNoneMatch = parseEntityTagHeader(req.headers["if-none-match"]);
        if (ifNoneMatch && entityTagMatches(ifNoneMatch, etag, true)) {
          return reply.code(304).header("etag", etag).send();
        }
        return reply
          .header("content-type", 'text/calendar; charset="utf-8"')
          .header("etag", etag)
          .send(calendarObjectForTask(task, tags));
      }

      if (req.method === "PUT") {
        let parsed: ParsedVtodo;
        try {
          parsed = parseCalDavIcs(String(req.body ?? ""));
        } catch (err) {
          if (err instanceof CalDavIcsError) {
            return caldavError(reply, err.status, err.precondition ?? "valid-calendar-data", err.message);
          }
          throw err;
        }
        if (parsed.method) {
          return caldavError(
            reply,
            400,
            "valid-calendar-data",
            "METHOD is not allowed in a CalDAV calendar object resource.",
          );
        }

        const existingResource = resourceForCollectionHref(collection, href);
        const existingException = existingResource?.exception ?? null;
        const existing = existingException ? null : (existingResource?.task ?? null);

        if (parsed.recurrenceId) {
          const recurrenceId = canonicalRecurrenceId(parsed.recurrenceId);
          if (!recurrenceId) {
            return caldavError(
              reply,
              400,
              "valid-calendar-data",
              "RECURRENCE-ID is not a valid date or date-time.",
            );
          }
          if (
            parsed.recurrenceRange &&
            parsed.recurrenceRange !== "THIS"
          ) {
            return caldavError(
              reply,
              400,
              "valid-calendar-data",
              "Only RANGE=THIS recurrence exceptions are supported.",
            );
          }
          let uid = parsed.uid?.trim() || null;
          let base = uid ? taskForCollectionUid(collection, uid) : null;
          if (!base && existingException) {
            base = taskForCollectionId(
              collection,
              existingException.task_id,
            );
          }
          if (!base) {
            return caldavError(
              reply,
              404,
              "valid-calendar-data",
              "The recurring series for this RECURRENCE-ID does not exist.",
            );
          }
          if (!uid) uid = icalUidFor(base);
          if (uid !== icalUidFor(base)) {
            return uidConflict(reply, resourceHref(collection, base));
          }
          if (!existingException && existing) {
            return reply.code(409).send();
          }
          // The href may already be a different series' exception. Rebinding
          // that row to this UID would corrupt the other series.
          if (existingException && existingException.task_id !== base.id) {
            return davError(
              reply,
              409,
              "no-uid-conflict",
              "The resource href is already used by a recurrence exception of another series.",
            );
          }
          const byRecurrence = liveExceptionByRecurrence(
            base.id,
            recurrenceId,
          );
          if (
            existingException &&
            byRecurrence &&
            existingException.id !== byRecurrence.id
          ) {
            return reply.code(409).send();
          }
          const effective = existingException
            ? { task: existingResource!.task, exception: existingException }
            : byRecurrence
              ? exceptionResourceForId(collection, byRecurrence.id)
              : null;
          const existingEtag = effective
            ? etagFor(
                effective.task,
                tagsForTask(user.id, effective.task.id),
              )
            : null;
          if (!checkWritePreconditions(req, reply, existingEtag)) return reply;

          const task = upsertException(
            collection,
            parsed,
            base,
            effective,
            href,
            recurrenceId,
          );
          return reply
            .code(effective ? 204 : 201)
            .header(
              "etag",
              etagFor(task, tagsForTask(user.id, task.id)),
            )
            .send();
        }

        // A base resource must not take an exception resource's href: reads
        // resolve the base first and would permanently shadow the exception.
        if (existingException) {
          return davError(
            reply,
            409,
            "no-uid-conflict",
            "The resource href is already used by a recurrence exception. Use a distinct href for the base series.",
          );
        }
        const existingTags = existing ? tagsForTask(user.id, existing.id) : [];
        const existingEtag = existing ? etagFor(existing, existingTags) : null;
        if (!checkWritePreconditions(req, reply, existingEtag)) return reply;

        const existingUid = existing ? icalUidFor(existing) : null;
        let uid = parsed.uid?.trim() || null;
        if (!uid && !existing) {
          return caldavError(
            reply,
            400,
            "valid-calendar-data",
            "A VTODO created through CalDAV must include UID.",
          );
        }
        if (!uid && existing) uid = existingUid;
        if (!uid) {
          return caldavError(
            reply,
            400,
            "valid-calendar-data",
            "A VTODO must include UID.",
          );
        }
        if (existing && uid !== existingUid) {
          return uidConflict(reply, resourceHref(collection, existing));
        }
        const byUid = taskForCollectionUid(collection, uid);
        if (byUid && byUid.id !== existing?.id) {
          return uidConflict(reply, resourceHref(collection, byUid));
        }

        let task: CalTask;
        try {
          task = upsertTask(user, collection, parsed, existing, href, uid);
        } catch (err) {
          if (err instanceof CalDavIcsError) {
            return caldavError(
              reply,
              err.status,
              err.precondition ?? "valid-calendar-data",
              err.message,
            );
          }
          if (isUniqueConstraint(err)) {
            if (isExceptionUniqueConstraint(err)) {
              return davError(
                reply,
                409,
                "no-uid-conflict",
                "The recurrence exception identity is already live in this collection.",
              );
            }
            const conflict = taskForCollectionUid(collection, uid);
            if (conflict) {
              return uidConflict(
                reply,
                resourceHref(collection, conflict),
              );
            }
            return reply.code(409).send();
          }
          throw err;
        }

        const fresh = taskForCollectionHref(collection, href) ?? task;
        return reply
          .code(existing ? 204 : 201)
          .header(
            "etag",
            etagFor(fresh, tagsForTask(user.id, fresh.id)),
          )
          .send();
      }

      if (req.method === "DELETE") {
        const resource = resourceForCollectionHref(collection, href);
        const existing = resource?.task ?? null;
        if (!existing) return reply.code(404).send();
        const existingEtag = etagFor(
          existing,
          tagsForTask(user.id, existing.id),
        );
        if (!checkWritePreconditions(req, reply, existingEtag)) return reply;
        const now = nowIso();
        const db = getDb();
        const remove = db.transaction(() => {
          if (resource?.exception) {
            db.prepare(
              `UPDATE task_recurrence_exceptions
                  SET deleted_at = ?, rev = rev + 1, updated_at = ?
                WHERE id = ?`,
            ).run(now, now, resource.exception.id);
            if (isExdateException(resource.exception)) {
              touchBaseForExdateChange(resource.exception.task_id, now);
            }
          } else {
            db.prepare(
              `UPDATE tasks SET deleted_at = ?, rev = rev + 1, updated_at = ?
                WHERE id = ?`,
            ).run(now, now, existing.id);
          }
        });
        remove();
        return reply.code(204).send();
      }

      if (req.method === "PROPFIND") {
        const resource = resourceForCollectionHref(collection, href);
        const task = resource?.task ?? null;
        if (!task) return reply.code(404).send();
        const etag = etagFor(task, tagsForTask(user.id, task.id));
        return reply
          .code(207)
          .header("content-type", "application/xml; charset=utf-8")
          .send(
            multistatus([
              responseBlock(resourceHref(collection, task), resourceProps(etag)),
            ]),
          );
      }

      return reply.code(404).send();
    },
  });
}
