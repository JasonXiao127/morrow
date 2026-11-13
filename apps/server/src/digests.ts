/**
 * Morning brief + weekly review (v0.2).
 *
 * These are user-level notifications, not task deliveries: they have no
 * occurrence key and must not create a synthetic task. The scheduler calls
 * this once per tick under its lease; a settings marker prevents duplicate
 * sends after a restart. Both Web Push and ntfy are attempted when enabled.
 */
import type { BetterDb } from "@morrow/db";
import {
  addWallDays,
  isValidTimeZone,
  newId,
  nowIso,
  wallDateTimeInZone,
} from "@morrow/shared";
import { TASK_ACCESS_SQL } from "./access.js";
import { readNtfyConfig, sendNtfy } from "./ntfy.js";
import { sendDirectPush, type PushSendOptions } from "./push.js";

interface DigestSettings {
  morning: { enabled: boolean; time: string };
  weekly: { enabled: boolean; day: number; time: string };
}

export interface DigestSendResult {
  morning: boolean;
  weekly: boolean;
  channels: { webpush: number; ntfy: boolean };
}

function parseSetting(value: string): unknown {
  try {
    const once: unknown = JSON.parse(value);
    return typeof once === "string" ? JSON.parse(once) : once;
  } catch {
    return value;
  }
}

function normalizeTime(value: unknown, fallback: string): string {
  return typeof value === "string" && /^\d{2}:\d{2}/.test(value)
    ? value.slice(0, 5)
    : fallback;
}

export function readDigestSettings(db: BetterDb): DigestSettings {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'digest' AND deleted_at IS NULL")
    .get() as { value: string } | undefined;
  const raw = row ? parseSetting(row.value) : null;
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const morningRaw =
    obj["morning"] && typeof obj["morning"] === "object"
      ? (obj["morning"] as Record<string, unknown>)
      : {};
  const weeklyRaw =
    obj["weekly"] && typeof obj["weekly"] === "object"
      ? (obj["weekly"] as Record<string, unknown>)
      : {};
  const dayRaw = Number(weeklyRaw["day"] ?? 1);
  return {
    morning: {
      enabled: morningRaw["enabled"] === true,
      time: normalizeTime(morningRaw["time"], "08:00"),
    },
    weekly: {
      enabled: weeklyRaw["enabled"] === true,
      day: Number.isSafeInteger(dayRaw) && dayRaw >= 0 && dayRaw <= 6 ? dayRaw : 1,
      time: normalizeTime(weeklyRaw["time"], "08:00"),
    },
  };
}

function readUser(db: BetterDb): { id: string; timezone: string } | null {
  try {
    // Briefs are owner-scoped. Do not fall back to the earliest member: in a
    // multi-account workspace that would silently mail another person's
    // reminders. Migration 0006 backfills an owner for legacy databases.
    const owner = db
      .prepare(
        "SELECT id, timezone FROM users WHERE deleted_at IS NULL AND role = 'owner' ORDER BY created_at ASC, id ASC LIMIT 1",
      )
      .get() as { id: string; timezone: string } | undefined;
    return owner ?? null;
  } catch {
    return null;
  }
}

function setting(db: BetterDb, key: string): string | null {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ? AND deleted_at IS NULL")
      .get(key) as { value: string } | undefined;
    if (!row) return null;
    const parsed = parseSetting(row.value);
    return typeof parsed === "string" ? parsed : row.value;
  } catch {
    return null;
  }
}

function setSetting(db: BetterDb, key: string, value: string): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO settings (key, value, rev, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       rev = rev + 1, updated_at = excluded.updated_at, deleted_at = NULL`,
  ).run(key, JSON.stringify(value), now);
}

function dayKey(iso: string, tz: string): string | null {
  try {
    return wallDateTimeInZone(new Date(iso), tz).slice(0, 10);
  } catch {
    return null;
  }
}

function today(tz: string, now: Date): string {
  try {
    return wallDateTimeInZone(now, tz).slice(0, 10);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function isoWeekKey(localDate: string): string {
  const date = new Date(`${localDate}T00:00:00Z`);
  const temp = new Date(date);
  const day = (temp.getUTCDay() + 6) % 7;
  temp.setUTCDate(temp.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(temp.getUTCFullYear(), 0, 4));
  const firstDay = (first.getUTCDay() + 6) % 7;
  first.setUTCDate(first.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((temp.getTime() - first.getTime()) / 604800000);
  return `${temp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

interface TaskBriefRow {
  id: string;
  title: string;
  due_at: string | null;
  due_date: string | null;
  all_day: number;
  next_occurrence_at: string | null;
  next_occurrence_local: string | null;
  status: string;
  priority: number;
}

function effectiveDay(row: TaskBriefRow, tz: string): string | null {
  if (row.all_day && row.next_occurrence_local) {
    return row.next_occurrence_local.slice(0, 10);
  }
  if (row.all_day && row.due_date) return row.due_date.slice(0, 10);
  const instant = row.next_occurrence_at ?? row.due_at;
  if (instant) return dayKey(instant, tz);
  return row.due_date?.slice(0, 10) ?? null;
}

function taskSummary(db: BetterDb, now: Date, tz: string, userId: string) {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.due_at, t.due_date, t.all_day,
              t.next_occurrence_at, t.next_occurrence_local, t.status, t.priority
         FROM tasks t
        WHERE (${TASK_ACCESS_SQL}) AND t.deleted_at IS NULL AND t.status = 'open'`,
    )
    .all(userId, userId, userId) as TaskBriefRow[];
  const todayKey = today(tz, now);
  const nextWeek = addWallDays(todayKey, 7);
  let overdue = 0;
  let dueToday = 0;
  let next7 = 0;
  let unscheduled = 0;
  const todayTitles: string[] = [];
  for (const row of rows) {
    const day = effectiveDay(row, tz);
    if (!day) {
      unscheduled += 1;
      continue;
    }
    if (day < todayKey) overdue += 1;
    else if (day === todayKey) {
      dueToday += 1;
      if (todayTitles.length < 3) todayTitles.push(row.title);
    } else if (day <= nextWeek) next7 += 1;
  }
  const weekStartMs = now.getTime() - now.getUTCDay() * 86400000;
  const weekStart = new Date(weekStartMs).toISOString();
  let completedWeek = 0;
  let missedWeek = 0;
  try {
    completedWeek = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM task_completions c
             JOIN tasks t ON t.id = c.task_id
            WHERE c.status = 'completed' AND c.deleted_at IS NULL
              AND c.completed_at >= ? AND (${TASK_ACCESS_SQL})`,
        )
        .get(weekStart, userId, userId, userId) as { n: number }
    ).n;
    missedWeek = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM task_completions c
             JOIN tasks t ON t.id = c.task_id
            WHERE c.status = 'missed' AND c.deleted_at IS NULL
              AND c.completed_at >= ? AND (${TASK_ACCESS_SQL})`,
        )
        .get(weekStart, userId, userId, userId) as { n: number }
    ).n;
  } catch {
    // Completion table is best-effort.
  }
  return {
    overdue,
    dueToday,
    next7,
    unscheduled,
    todayTitles,
    completedWeek,
    missedWeek,
    open: rows.length,
  };
}

function briefText(
  kind: "morning" | "weekly",
  summary: ReturnType<typeof taskSummary>,
): { title: string; body: string } {
  if (kind === "morning") {
    const lines = [
      `${summary.dueToday} due today · ${summary.overdue} overdue · ${summary.next7} in the next 7 days`,
    ];
    if (summary.todayTitles.length > 0) {
      lines.push(`Today: ${summary.todayTitles.join(" · ")}`);
    }
    if (summary.unscheduled > 0) {
      lines.push(`${summary.unscheduled} unscheduled in Inbox`);
    }
    return { title: "Morning brief", body: lines.join("\n") };
  }
  return {
    title: "Weekly review",
    body: [
      `${summary.completedWeek} completed this week · ${summary.missedWeek} missed`,
      `${summary.open} open · ${summary.overdue} overdue · ${summary.unscheduled} unscheduled`,
      "Open Morrow to plan the week ahead.",
    ].join("\n"),
  };
}

function canSend(db: BetterDb, userId: string): boolean {
  if (readNtfyConfig(db)) return true;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM push_subscriptions
          WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL`,
      )
      .get(userId) as { n: number };
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

async function deliver(
  db: BetterDb,
  userId: string,
  payload: { title: string; body: string },
  options: PushSendOptions,
): Promise<{ webpush: number; ntfy: boolean }> {
  const push = await sendDirectPush(
    db,
    userId,
    {
      title: payload.title,
      body: payload.body,
      url: "/today",
      taskId: null,
      badgeCount: 1,
      kind: "digest",
    },
    options,
  );
  let ntfy = false;
  const config = readNtfyConfig(db);
  if (config) {
    const sent = await sendNtfy(config, {
      title: payload.title,
      body: payload.body,
      tags: ["calendar"],
      priority: 3,
      url: `${(process.env["APP_URL"] ?? "").replace(/\/$/, "")}/today`,
    });
    ntfy = sent.ok;
  }
  return { webpush: push.sent, ntfy };
}

/** Called from the scheduler tick (under its lease). */
export async function maybeSendDigests(
  db: BetterDb,
  now: Date,
  options: PushSendOptions = {},
): Promise<DigestSendResult> {
  const result: DigestSendResult = {
    morning: false,
    weekly: false,
    channels: { webpush: 0, ntfy: false },
  };
  const user = readUser(db);
  if (!user) return result;
  const tz = isValidTimeZone(user.timezone) ? user.timezone : "UTC";
  const settings = readDigestSettings(db);
  if (!settings.morning.enabled && !settings.weekly.enabled) return result;
  if (!canSend(db, user.id)) return result;

  let wall = "";
  try {
    wall = wallDateTimeInZone(now, tz);
  } catch {
    return result;
  }
  const localDate = wall.slice(0, 10);
  const localTime = wall.slice(11, 16);
  const weekday = new Date(`${localDate}T12:00:00Z`).getUTCDay();
  const summary = taskSummary(db, now, tz, user.id);

  if (
    settings.morning.enabled &&
    localTime >= settings.morning.time &&
    setting(db, "digest.lastMorning") !== localDate
  ) {
    const brief = briefText("morning", summary);
    const channels = await deliver(db, user.id, brief, options);
    setSetting(db, "digest.lastMorning", localDate);
    result.morning = true;
    result.channels.webpush += channels.webpush;
    result.channels.ntfy = result.channels.ntfy || channels.ntfy;
    recordBriefActivity(db, user.id, "brief.morning", brief, channels);
  }

  const weekKey = isoWeekKey(localDate);
  if (
    settings.weekly.enabled &&
    weekday === settings.weekly.day &&
    localTime >= settings.weekly.time &&
    setting(db, "digest.lastWeekly") !== weekKey
  ) {
    const brief = briefText("weekly", summary);
    const channels = await deliver(db, user.id, brief, options);
    setSetting(db, "digest.lastWeekly", weekKey);
    result.weekly = true;
    result.channels.webpush += channels.webpush;
    result.channels.ntfy = result.channels.ntfy || channels.ntfy;
    recordBriefActivity(db, user.id, "brief.weekly", brief, channels);
  }
  return result;
}

function recordBriefActivity(
  db: BetterDb,
  userId: string,
  action: string,
  brief: { title: string; body: string },
  channels: { webpush: number; ntfy: boolean },
): void {
  try {
    db.prepare(
      `INSERT INTO activity
         (batch_id, actor, actor_id, action, entity_type, entity_id, after_json,
          summary, created_at)
       VALUES (?, 'scheduler', ?, ?, 'brief', ?, ?, ?, ?)`,
    ).run(
      newId(),
      userId,
      action,
      newId(),
      JSON.stringify({ channels, body: brief.body.slice(0, 1000) }),
      `${brief.title} sent (${channels.webpush} push, ntfy ${channels.ntfy ? "yes" : "no"})`,
      nowIso(),
    );
  } catch {
    // Best-effort audit.
  }
}
