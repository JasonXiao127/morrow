/**
 * Reminder arming (§2): due-date-only, all-day, offset, and timezone edits
 * must all arm and fire. Scheduler covers the enqueue path; derivation is
 * unit-tested via the shared helper.
 */
import { describe, expect, it, afterEach } from "vitest";
import { openDatabase, type MorrowDatabase } from "@morrow/db";
import {
  deriveReminder,
  newId,
  resolveAllDayReminder,
} from "@morrow/shared";
import {
  enqueueDueWork,
} from "../src/scheduler.js";

const USER_ID = "01900000-0000-7000-8000-000000000001";

const databases: MorrowDatabase[] = [];

function setup(): MorrowDatabase {
  const database = openDatabase({ path: ":memory:" });
  databases.push(database);
  database.sqlite
    .prepare(
      `INSERT INTO users (id, username, password_hash, timezone, created_at, updated_at)
       VALUES (?, 'owner', 'not-a-real-hash', 'UTC', ?, ?)`,
    )
    .run(USER_ID, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  return database;
}

afterEach(() => {
  while (databases.length > 0) {
    try {
      databases.pop()?.close();
    } catch {
      // ignore
    }
  }
});

function insertTask(
  database: MorrowDatabase,
  overrides: Record<string, unknown> = {},
): string {
  const id = (overrides["id"] as string) ?? newId();
  const now = "2026-01-01T00:00:00.000Z";
  const cols = [
    "id",
    "user_id",
    "title",
    "status",
    "priority",
    "all_day",
    "timezone",
    "due_at",
    "due_date",
    "remind_at",
    "reminder_time_local",
    "remind_offset_minutes",
    "dtstart_local",
    "next_occurrence_at",
    "next_occurrence_local",
    "rrule",
    "recurrence_mode",
    "clamp_policy",
    "missed_count",
    "occurrence_seq",
    "created_at",
    "updated_at",
  ];
  const row: Record<string, unknown> = {
    id,
    user_id: USER_ID,
    title: "Test",
    status: "open",
    priority: 1,
    all_day: 0,
    timezone: "UTC",
    due_at: null,
    due_date: null,
    remind_at: null,
    reminder_time_local: null,
    remind_offset_minutes: null,
    dtstart_local: null,
    next_occurrence_at: null,
    next_occurrence_local: null,
    rrule: null,
    recurrence_mode: "schedule",
    clamp_policy: "skip",
    missed_count: 0,
    occurrence_seq: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  row["id"] = id;
  row["user_id"] = USER_ID;
  database.sqlite
    .prepare(
      `INSERT INTO tasks (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    )
    .run(...cols.map((c) => row[c] ?? null));
  return id;
}

function count(
  database: MorrowDatabase,
  table: string,
  where = "",
): number {
  const row = database.sqlite
    .prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`)
    .get() as { n: number };
  return row.n;
}

describe("deriveReminder", () => {
  it("derives remind_at from dueAt with zero offset", () => {
    const out = deriveReminder({
      dueAt: "2026-11-02T12:00:00.000Z",
      allDay: false,
      fallbackTimezone: "UTC",
      explicitRemindAt: undefined,
    });
    expect(out.remindAt).toBe("2026-11-02T12:00:00.000Z");
  });

  it("applies offset -10 (ten minutes before due)", () => {
    const out = deriveReminder({
      dueAt: "2026-11-02T12:00:00.000Z",
      allDay: false,
      fallbackTimezone: "UTC",
      remindOffsetMinutes: -10,
      explicitRemindAt: undefined,
    });
    expect(out.remindAt).toBe("2026-11-02T11:50:00.000Z");
  });

  it("resolves all-day dueDate at 09:00 local by default", () => {
    const out = deriveReminder({
      dueDate: "2026-11-03",
      allDay: true,
      fallbackTimezone: "UTC",
      explicitRemindAt: undefined,
    });
    expect(out.remindAt).toBe("2026-11-03T09:00:00.000Z");
  });

  it("respects explicit remindAt including null", () => {
    const kept = deriveReminder({
      dueAt: "2026-11-02T12:00:00.000Z",
      allDay: false,
      fallbackTimezone: "UTC",
      explicitRemindAt: "2026-11-02T11:00:00.000Z",
    });
    expect(kept.remindAt).toBe("2026-11-02T11:00:00.000Z");
    const cleared = deriveReminder({
      dueAt: "2026-11-02T12:00:00.000Z",
      allDay: false,
      fallbackTimezone: "UTC",
      explicitRemindAt: null,
    });
    expect(cleared.remindAt).toBeNull();
  });

  it("computes a real instant for recurring all-day", () => {
    const out = deriveReminder({
      allDay: true,
      fallbackTimezone: "UTC",
      rrule: "FREQ=DAILY",
      dtstartLocal: "2026-11-03",
      explicitRemindAt: undefined,
    });
    expect(out.nextOccurrenceAt).toBe("2026-11-03T09:00:00.000Z");
    expect(out.nextOccurrenceLocal).toBe("2026-11-03");
    expect(out.remindAt).toBe("2026-11-03T09:00:00.000Z");
  });

  it("re-resolves across timezones (past keys untouched by caller)", () => {
    // 09:00 in New York is 14:00 UTC (EST, November).
    const ny = resolveAllDayReminder("2026-11-03", "09:00:00", "America/New_York");
    expect(ny.instantIso).toBe("2026-11-03T14:00:00.000Z");
    const utc = resolveAllDayReminder("2026-11-03", "09:00:00", "UTC");
    expect(utc.instantIso).toBe("2026-11-03T09:00:00.000Z");
    expect(ny.instantIso).not.toBe(utc.instantIso);
  });
});

describe("scheduler due-date fallback", () => {
  it("enqueues a past-due dueAt task with no remind_at", () => {
    const db = setup();
    const taskId = insertTask(db, {
      title: "Past dueAt",
      due_at: "2026-11-02T11:00:00.000Z",
      remind_at: null,
      next_occurrence_at: null,
    });
    const result = enqueueDueWork(db.sqlite, {
      now: new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(result.deliveriesInserted).toBe(1);
    expect(count(db, "deliveries", `WHERE task_id = '${taskId}'`)).toBe(1);
    expect(count(db, "activity", `WHERE entity_id = '${taskId}'`)).toBeGreaterThan(0);
  });

  it("enqueues a one-off all-day task at 09:00 local", () => {
    const db = setup();
    const taskId = insertTask(db, {
      title: "All-day one-off",
      all_day: 1,
      due_date: "2026-11-02",
      reminder_time_local: null,
      remind_at: null,
    });
    const result = enqueueDueWork(db.sqlite, {
      now: new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(result.deliveriesInserted).toBe(1);
    const row = db.sqlite
      .prepare("SELECT occurrence_key FROM deliveries WHERE task_id = ?")
      .get(taskId) as { occurrence_key: string };
    expect(row.occurrence_key).toBe("2026-11-02");
  });

  it("does not enqueue an all-day task before its 09:00 reminder", () => {
    const db = setup();
    insertTask(db, {
      title: "All-day future",
      all_day: 1,
      due_date: "2026-11-02",
      remind_at: null,
    });
    const result = enqueueDueWork(db.sqlite, {
      now: new Date("2026-11-02T08:00:00.000Z"),
    });
    expect(result.deliveriesInserted).toBe(0);
  });

  it("enqueues an armless recurring all-day series via stored local", () => {
    const db = setup();
    const taskId = insertTask(db, {
      title: "Recurring all-day legacy",
      all_day: 1,
      due_date: "2026-11-02",
      rrule: "FREQ=DAILY",
      dtstart_local: "2026-11-01",
      next_occurrence_at: null,
      next_occurrence_local: "2026-11-02",
      remind_at: null,
    });
    const result = enqueueDueWork(db.sqlite, {
      now: new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(result.deliveriesInserted).toBe(1);
    expect(count(db, "deliveries", `WHERE task_id = '${taskId}'`)).toBe(1);
  });

  it("repeat ticks do not duplicate deliveries or churn rev", () => {
    const db = setup();
    const taskId = insertTask(db, {
      title: "Past dueAt repeat",
      due_at: "2026-11-02T11:00:00.000Z",
    });
    const now = new Date("2026-11-02T12:00:00.000Z");
    const first = enqueueDueWork(db.sqlite, { now });
    expect(first.deliveriesInserted).toBe(1);
    const revAfterFirst = (
      db.sqlite.prepare("SELECT rev FROM tasks WHERE id = ?").get(taskId) as {
        rev: number;
      }
    ).rev;
    const second = enqueueDueWork(db.sqlite, { now });
    expect(second.deliveriesInserted).toBe(0);
    const revAfterSecond = (
      db.sqlite.prepare("SELECT rev FROM tasks WHERE id = ?").get(taskId) as {
        rev: number;
      }
    ).rev;
    expect(revAfterSecond).toBe(revAfterFirst);
  });
});
