import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type MorrowDatabase } from "@morrow/db";
import { newId } from "@morrow/shared";
import {
  DIGEST_DOWNTIME_MS,
  acquireSchedulerLease,
  claimDeliveries,
  enqueueDueWork,
  markSent,
  readQuietHours,
  runSchedulerTick,
  quietHoursEnd,
  type ClaimedDelivery,
} from "../src/scheduler.js";
import {
  batchBucket,
  processDelivery,
  pushTopic,
  serializePushPayload,
  validatePushEndpoint,
  type PushConfig,
  type PushTransport,
} from "../src/push.js";

const USER_ID = "01900000-0000-7000-8000-000000000001";
const SUB_ID = "01900000-0000-7000-8000-0000000000aa";
const FCM_ENDPOINT =
  "https://fcm.googleapis.com/fcm/send/morrow-test-endpoint";

const PUSH_CONFIG: PushConfig = {
  enabled: true,
  publicKey: "BPublicKeyForTestsOnly",
  privateKey: "PrivateKeyForTestsOnly",
  subject: "mailto:test@example.com",
};

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

interface TaskOverrides {
  id?: string;
  userId?: string;
  listId?: string | null;
  title?: string;
  priority?: number;
  allDay?: boolean;
  timezone?: string | null;
  rrule?: string | null;
  dtstartLocal?: string | null;
  nextOccurrenceAt?: string | null;
  nextOccurrenceLocal?: string | null;
  remindAt?: string | null;
  recurrenceMode?: "schedule" | "completion";
  dueDate?: string | null;
  missedCount?: number;
}

function insertTask(
  database: MorrowDatabase,
  overrides: TaskOverrides = {},
): string {
  const id = overrides.id ?? newId();
  const now = "2026-01-01T00:00:00.000Z";
  database.sqlite
    .prepare(
      `INSERT INTO tasks
         (id, user_id, list_id, title, status, priority, all_day, timezone, due_date,
          remind_at, dtstart_local, next_occurrence_at, next_occurrence_local,
          rrule, recurrence_mode, clamp_policy, missed_count, occurrence_seq,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'skip', ?, 0, ?, ?)`,
    )
    .run(
      id,
      overrides.userId ?? USER_ID,
      overrides.listId ?? null,
      overrides.title ?? "Test reminder",
      overrides.priority ?? 1,
      overrides.allDay ? 1 : 0,
      overrides.timezone === undefined ? "UTC" : overrides.timezone,
      overrides.dueDate ?? null,
      overrides.remindAt ?? null,
      overrides.dtstartLocal ?? null,
      overrides.nextOccurrenceAt ?? null,
      overrides.nextOccurrenceLocal ?? null,
      overrides.rrule ?? null,
      overrides.recurrenceMode ?? "schedule",
      overrides.missedCount ?? 0,
      now,
      now,
    );
  return id;
}

function insertSubscription(
  database: MorrowDatabase,
  overrides: {
    id?: string;
    endpoint?: string;
    enabled?: boolean;
    userId?: string;
  } = {},
): string {
  const id = overrides.id ?? SUB_ID;
  const endpoint = overrides.endpoint ?? FCM_ENDPOINT;
  database.sqlite
    .prepare(
      `INSERT INTO push_subscriptions
         (id, user_id, endpoint, endpoint_hash, p256dh, auth, enabled,
          fail_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'p256dh-test', 'auth-test', ?, 0, ?, ?)`,
    )
    .run(
      id,
      overrides.userId ?? USER_ID,
      endpoint,
      `hash-${id}`,
      overrides.enabled === false ? 0 : 1,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  return id;
}

function insertDelivery(
  database: MorrowDatabase,
  taskId: string,
  options: {
    subscriptionId?: string;
    kind?: "reminder" | "digest";
    nextAttemptAt?: string | null;
    attempts?: number;
  } = {},
): string {
  const id = newId();
  database.sqlite
    .prepare(
      `INSERT INTO deliveries
         (id, task_id, occurrence_key, kind, channel, subscription_id, status,
          attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, '2026-11-02T12:00:00.000Z', ?, 'webpush', ?, 'pending', ?,
               ?, ?, ?)`,
    )
    .run(
      id,
      taskId,
      options.kind ?? "reminder",
      options.subscriptionId ?? SUB_ID,
      options.attempts ?? 0,
      options.nextAttemptAt ?? null,
      "2026-11-02T12:00:00.000Z",
      "2026-11-02T12:00:00.000Z",
    );
  return id;
}

function count(
  database: MorrowDatabase,
  table: "deliveries" | "task_completions" | "activity",
  where = "",
  ...params: unknown[]
): number {
  const row = database.sqlite
    .prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`)
    .get(...params) as { n: number };
  return row.n;
}

function getTask(
  database: MorrowDatabase,
  id: string,
): Record<string, unknown> {
  return database.sqlite
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(id) as Record<string, unknown>;
}

function getDelivery(
  database: MorrowDatabase,
  id: string,
): Record<string, unknown> {
  return database.sqlite
    .prepare("SELECT * FROM deliveries WHERE id = ?")
    .get(id) as Record<string, unknown>;
}

function failingTransport(error: {
  statusCode: number;
  headers?: Record<string, string>;
  message?: string;
}): PushTransport {
  return {
    async send() {
      throw Object.assign(new Error(error.message ?? `push ${error.statusCode}`), {
        statusCode: error.statusCode,
        headers: error.headers ?? {},
      });
    },
  };
}

describe("scheduler enqueue", () => {
  it("suppresses a reminder for a completed recurrence exception", () => {
    const database = setup();
    const taskId = insertTask(database, {
      title: "Exception series",
      rrule: "FREQ=DAILY",
      dtstartLocal: "2026-11-02T09:00:00",
      nextOccurrenceAt: "2026-11-02T09:00:00.000Z",
      nextOccurrenceLocal: "2026-11-02T09:00:00",
      timezone: "UTC",
    });
    database.sqlite
      .prepare(
        `INSERT INTO task_recurrence_exceptions
           (id, task_id, user_id, recurrence_id, caldav_href, patch_json,
            status, completed_at, ical_extra_json, rev, created_at,
            updated_at, deleted_at)
         VALUES ('exc-1', ?, ?, '2026-11-02T09:00:00.000Z', 'exc.ics', '{}',
                 'done', '2026-11-02T09:05:00.000Z', NULL, 1, ?, ?, NULL)`,
      )
      .run(taskId, USER_ID, "2026-11-02T09:05:00.000Z", "2026-11-02T09:05:00.000Z");

    const result = enqueueDueWork(database.sqlite, {
      now: new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(result.deliveriesInserted).toBe(0);
    expect(
      count(
        database,
        "task_completions",
        "WHERE task_id = ? AND status = 'completed'",
        taskId,
      ),
    ).toBe(1);
    const task = getTask(database, taskId);
    expect(task["next_occurrence_at"]).toBe("2026-11-03T09:00:00.000Z");
  });

  it("keeps member-private reminders off the workspace ntfy topic", () => {
    const database = setup();
    database.sqlite
      .prepare("UPDATE users SET role = 'owner' WHERE id = ?")
      .run(USER_ID);
    const memberId = "01900000-0000-7000-8000-000000000002";
    database.sqlite
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, timezone, created_at, updated_at)
         VALUES (?, 'member', 'not-a-real-hash', 'member', 'UTC', ?, ?)`,
      )
      .run(
        memberId,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    const now = new Date("2026-11-02T12:00:00.000Z");
    database.sqlite
      .prepare(
        `INSERT INTO settings (key, value, rev, updated_at) VALUES ('ntfy', ?, 1, ?)`,
      )
      .run(
        JSON.stringify({
          enabled: true,
          url: "https://ntfy.example",
          topic: "workspace-topic",
        }),
        now.toISOString(),
      );
    const ownerTask = insertTask(database, {
      title: "Owner reminder",
      remindAt: "2026-11-02T11:59:00.000Z",
    });
    const memberTask = insertTask(database, {
      userId: memberId,
      title: "Member private reminder",
      remindAt: "2026-11-02T11:59:00.000Z",
    });

    enqueueDueWork(database.sqlite, { now });

    const rows = database.sqlite
      .prepare("SELECT task_id FROM deliveries WHERE channel = 'ntfy'")
      .all() as Array<{ task_id: string }>;
    const taskIds = rows.map((row) => row.task_id);
    expect(taskIds).toContain(ownerTask);
    expect(taskIds).not.toContain(memberTask);
  });

  it("folds 10 missed days into one digest, 10 missed rows, and advances", () => {
    const database = setup();
    insertSubscription(database);
    const taskId = insertTask(database, {
      title: "Water plants",
      rrule: "FREQ=DAILY",
      dtstartLocal: "2026-10-24T09:00:00",
      nextOccurrenceAt: "2026-10-24T09:00:00.000Z",
      nextOccurrenceLocal: "2026-10-24T09:00:00",
    });

    const now = new Date("2026-11-02T12:00:00.000Z");
    const result = enqueueDueWork(database.sqlite, { now });

    expect(result.deliveriesInserted).toBe(1);
    expect(result.digests).toBe(1);
    expect(result.missedInserted).toBe(10);
    expect(count(database, "deliveries", "WHERE kind = 'digest'")).toBe(1);
    expect(count(database, "deliveries")).toBe(1);
    expect(
      count(database, "task_completions", "WHERE status = 'missed'"),
    ).toBe(10);

    const task = getTask(database, taskId);
    expect(task["next_occurrence_at"]).toBe("2026-11-03T09:00:00.000Z");
    expect(task["next_occurrence_local"]).toBe("2026-11-03T09:00:00");
    expect(task["missed_count"]).toBe(10);
    expect(task["occurrence_seq"]).toBe(10);
    expect(result.activities).toBeGreaterThanOrEqual(11);
    const state = database.sqlite
      .prepare("SELECT last_catchup_at FROM scheduler_state WHERE id = 1")
      .get() as { last_catchup_at: string | null };
    expect(state.last_catchup_at).toBe("2026-11-02T12:00:00.000Z");

    // Replaying the same boundary must not duplicate rows (INSERT OR IGNORE
    // plus the delivery unique key).
    database.sqlite
      .prepare(
        `UPDATE tasks SET next_occurrence_at = ?, next_occurrence_local = ?
         WHERE id = ?`,
      )
      .run("2026-10-24T09:00:00.000Z", "2026-10-24T09:00:00", taskId);
    const replay = enqueueDueWork(database.sqlite, { now });
    expect(replay.deliveriesInserted).toBe(0);
    expect(replay.missedInserted).toBe(0);
  });

  it("sends one digest when a single occurrence is more than 30 minutes late", () => {
    const database = setup();
    insertSubscription(database);
    const taskId = insertTask(database, {
      title: "Late single",
      rrule: "FREQ=DAILY",
      dtstartLocal: "2026-11-02T11:00:00",
      nextOccurrenceAt: "2026-11-02T11:00:00.000Z",
      nextOccurrenceLocal: "2026-11-02T11:00:00",
    });

    const result = enqueueDueWork(database.sqlite, {
      now: new Date("2026-11-02T12:00:00.000Z"),
    });

    expect(result.digests).toBe(1);
    expect(result.missedInserted).toBe(1);
    const delivery = database.sqlite
      .prepare("SELECT kind FROM deliveries WHERE task_id = ?")
      .get(taskId) as { kind: string };
    expect(delivery.kind).toBe("digest");
    expect(getTask(database, taskId)["next_occurrence_at"]).toBe(
      "2026-11-03T11:00:00.000Z",
    );
  });

  it("fires remind_at for a future occurrence without advancing it early", () => {
    const database = setup();
    insertSubscription(database);
    const taskId = insertTask(database, {
      title: "Reminder offset",
      rrule: "FREQ=DAILY",
      dtstartLocal: "2026-11-03T09:00:00",
      nextOccurrenceAt: "2026-11-03T09:00:00.000Z",
      nextOccurrenceLocal: "2026-11-03T09:00:00",
      remindAt: "2026-11-02T12:00:00.000Z",
    });

    const first = enqueueDueWork(database.sqlite, {
      now: new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(first.deliveriesInserted).toBe(1);
    let task = getTask(database, taskId);
    expect(task["next_occurrence_at"]).toBe("2026-11-03T09:00:00.000Z");
    expect(task["remind_at"]).toBeNull();
    expect(task["occurrence_seq"]).toBe(0);

    // When the occurrence catches up, the same occurrence key means no second
    // push, but the recurrence still advances.
    const second = enqueueDueWork(database.sqlite, {
      now: new Date("2026-11-03T09:00:00.000Z"),
    });
    expect(second.deliveriesInserted).toBe(0);
    task = getTask(database, taskId);
    expect(task["next_occurrence_at"]).toBe("2026-11-04T09:00:00.000Z");
  });

  it("completion mode never advances and never writes missed rows", () => {
    const database = setup();
    insertSubscription(database);
    const taskId = insertTask(database, {
      title: "Water plants",
      rrule: "FREQ=DAILY",
      dtstartLocal: "2026-10-24T09:00:00",
      nextOccurrenceAt: "2026-10-24T09:00:00.000Z",
      nextOccurrenceLocal: "2026-10-24T09:00:00",
      recurrenceMode: "completion",
    });
    const now = new Date("2026-11-02T12:00:00.000Z");

    const first = enqueueDueWork(database.sqlite, { now });
    const second = enqueueDueWork(database.sqlite, { now });

    expect(first.deliveriesInserted).toBe(1);
    expect(first.missedInserted).toBe(0);
    expect(second.deliveriesInserted).toBe(0);
    expect(count(database, "task_completions")).toBe(0);
    const task = getTask(database, taskId);
    expect(task["next_occurrence_at"]).toBe("2026-10-24T09:00:00.000Z");
    expect(task["occurrence_seq"]).toBe(0);
  });

  it("holds non-urgent reminders through quiet hours and lets urgent ones through", () => {
    const database = setup();
    insertSubscription(database);
    database.sqlite
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ('quietHours', ?, ?)`,
      )
      .run(
        JSON.stringify({ enabled: true, start: "22:00", end: "07:00" }),
        "2026-01-01T00:00:00.000Z",
      );

    const quiet = readQuietHours(database.sqlite);
    expect(quiet).toEqual({ enabled: true, start: "22:00:00", end: "07:00:00" });

    const quietTask = insertTask(database, {
      title: "Quiet task",
      priority: 1,
      nextOccurrenceAt: "2026-11-02T23:30:00.000Z",
      nextOccurrenceLocal: "2026-11-02T23:30:00",
    });
    const urgentTask = insertTask(database, {
      title: "Urgent task",
      priority: 3,
      nextOccurrenceAt: "2026-11-02T23:30:00.000Z",
      nextOccurrenceLocal: "2026-11-02T23:30:00",
    });

    const now = new Date("2026-11-02T23:30:00.000Z");
    enqueueDueWork(database.sqlite, { now });

    const quietDelivery = database.sqlite
      .prepare("SELECT next_attempt_at FROM deliveries WHERE task_id = ?")
      .get(quietTask) as { next_attempt_at: string };
    const urgentDelivery = database.sqlite
      .prepare("SELECT next_attempt_at FROM deliveries WHERE task_id = ?")
      .get(urgentTask) as { next_attempt_at: string };

    expect(quietDelivery.next_attempt_at).toBe("2026-11-03T07:00:00.000Z");
    expect(urgentDelivery.next_attempt_at).toBe("2026-11-02T23:30:00.000Z");
    expect(
      Number(quietHoursEnd(now, "UTC", quiet!).getTime()),
    ).toBe(Date.parse("2026-11-03T07:00:00.000Z"));
  });

  it("delivers a shared all-day reminder at each recipient's local 09:00", () => {
    const database = setup();
    const memberId = "01900000-0000-7000-8000-000000000002";
    const memberSubId = "01900000-0000-7000-8000-0000000000bb";
    const listId = "01900000-0000-7000-8000-0000000000cc";
    const now = "2026-01-01T00:00:00.000Z";
    database.sqlite
      .prepare(
        `INSERT INTO users (id, username, password_hash, timezone, created_at, updated_at)
         VALUES (?, 'member', 'not-a-real-hash', 'Pacific/Auckland', ?, ?)`,
      )
      .run(memberId, now, now);
    insertSubscription(database);
    insertSubscription(database, {
      id: memberSubId,
      userId: memberId,
      endpoint: "https://fcm.googleapis.com/fcm/send/member-endpoint",
    });
    database.sqlite
      .prepare(
        `INSERT INTO lists
           (id, user_id, name, sort_key, is_inbox, rev, created_at, updated_at)
         VALUES (?, ?, 'Shared all-day', 'V00000000000000', 0, 1, ?, ?)`,
      )
      .run(listId, USER_ID, now, now);
    database.sqlite
      .prepare(
        `INSERT INTO list_members (list_id, user_id, role, created_at)
         VALUES (?, ?, 'member', ?)`,
      )
      .run(listId, memberId, now);

    const taskId = insertTask(database, {
      title: "Shared birthday",
      listId,
      allDay: true,
      dueDate: "2026-11-03",
      timezone: null,
    });

    // 09:30 on 3 Nov in Auckland (UTC+13) is 20:30 on 2 Nov in UTC.
    enqueueDueWork(database.sqlite, {
      now: new Date("2026-11-02T20:30:00.000Z"),
    });
    let rows = database.sqlite
      .prepare(
        "SELECT subscription_id, status, next_attempt_at FROM deliveries WHERE task_id = ? ORDER BY created_at",
      )
      .all(taskId) as Array<{
      subscription_id: string;
      status: string;
      next_attempt_at: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subscription_id).toBe(memberSubId);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.next_attempt_at).toBe("2026-11-02T20:30:00.000Z");

    // The owner's 09:00 UTC arrives later; the member row is not duplicated.
    enqueueDueWork(database.sqlite, {
      now: new Date("2026-11-03T09:00:00.000Z"),
    });
    rows = database.sqlite
      .prepare(
        "SELECT subscription_id, status, next_attempt_at FROM deliveries WHERE task_id = ? ORDER BY created_at",
      )
      .all(taskId) as typeof rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.subscription_id).sort()).toEqual(
      [SUB_ID, memberSubId].sort(),
    );
    expect(
      rows.find((row) => row.subscription_id === SUB_ID)!.next_attempt_at,
    ).toBe("2026-11-03T09:00:00.000Z");
  });

  it("evaluates quiet hours in each recipient's timezone", () => {
    const database = setup();
    const memberId = "01900000-0000-7000-8000-000000000003";
    const memberSubId = "01900000-0000-7000-8000-0000000000dd";
    const listId = "01900000-0000-7000-8000-0000000000ee";
    const now = "2026-01-01T00:00:00.000Z";
    database.sqlite
      .prepare(
        `INSERT INTO users (id, username, password_hash, timezone, created_at, updated_at)
         VALUES (?, 'member-quiet', 'not-a-real-hash', 'Pacific/Auckland', ?, ?)`,
      )
      .run(memberId, now, now);
    insertSubscription(database);
    insertSubscription(database, {
      id: memberSubId,
      userId: memberId,
      endpoint: "https://fcm.googleapis.com/fcm/send/member-quiet-endpoint",
    });
    database.sqlite
      .prepare(
        `INSERT INTO lists
           (id, user_id, name, sort_key, is_inbox, rev, created_at, updated_at)
         VALUES (?, ?, 'Shared quiet', 'V00000000000000', 0, 1, ?, ?)`,
      )
      .run(listId, USER_ID, now, now);
    database.sqlite
      .prepare(
        `INSERT INTO list_members (list_id, user_id, role, created_at)
         VALUES (?, ?, 'member', ?)`,
      )
      .run(listId, memberId, now);
    database.sqlite
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ('quietHours', ?, ?)`,
      )
      .run(
        JSON.stringify({ enabled: true, start: "22:00", end: "07:00" }),
        now,
      );

    const taskId = insertTask(database, {
      title: "Shared timed reminder",
      listId,
      priority: 1,
      nextOccurrenceAt: "2026-11-02T23:00:00.000Z",
      nextOccurrenceLocal: "2026-11-02T23:00:00",
    });

    // 23:00 UTC is inside the owner's quiet window; Auckland is at noon the
    // next day, so the member's reminder is not held.
    enqueueDueWork(database.sqlite, {
      now: new Date("2026-11-02T23:00:00.000Z"),
    });
    const rows = database.sqlite
      .prepare(
        "SELECT subscription_id, next_attempt_at FROM deliveries WHERE task_id = ?",
      )
      .all(taskId) as Array<{
      subscription_id: string;
      next_attempt_at: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(
      rows.find((row) => row.subscription_id === SUB_ID)!.next_attempt_at,
    ).toBe("2026-11-03T07:00:00.000Z");
    expect(
      rows.find((row) => row.subscription_id === memberSubId)!.next_attempt_at,
    ).toBe("2026-11-02T23:00:00.000Z");
  });

  it("prunes the CalDAV journal on the tick once it exceeds the cap", async () => {
    const database = setup();
    const insert = database.sqlite.prepare(
      `INSERT INTO caldav_changes
         (collection, user_id, task_id, href, change_type, changed_at)
       VALUES ('inbox', ?, 'task-a', ?, 'update', ?)`,
    );
    const bulk = database.sqlite.transaction(() => {
      for (let index = 0; index < 50_100; index += 1) {
        insert.run(USER_ID, `journal-${index}.ics`, "2026-01-01T00:00:00.000Z");
      }
    });
    bulk();

    await runSchedulerTick(database.sqlite, {
      now: new Date("2026-11-02T12:00:00.000Z"),
      send: false,
      skipLease: false,
      owner: "journal-prune-test",
    });
    expect(
      (
        database.sqlite
          .prepare("SELECT COUNT(*) AS n FROM caldav_changes")
          .get() as { n: number }
      ).n,
    ).toBe(40_000);
  });

  it("resolves quiet-hour end across DST gaps and folds", () => {
    const quiet = { enabled: true, start: "22:00:00", end: "02:30:00" };
    // 01:00 EST on spring-forward day; 02:30 does not exist -> 03:30 EDT.
    expect(
      quietHoursEnd(
        new Date("2026-03-08T06:00:00.000Z"),
        "America/New_York",
        quiet,
      ).toISOString(),
    ).toBe("2026-03-08T07:30:00.000Z");

    // 00:00 EDT on fall-back day; 01:30 is ambiguous -> first occurrence.
    expect(
      quietHoursEnd(
        new Date("2026-11-01T04:00:00.000Z"),
        "America/New_York",
        { enabled: true, start: "22:00:00", end: "01:30:00" },
      ).toISOString(),
    ).toBe("2026-11-01T05:30:00.000Z");
  });

  it("advances a spring-forward 02:30 occurrence to 03:30", () => {
    const database = setup();
    insertSubscription(database);
    const taskId = insertTask(database, {
      title: "DST spring",
      timezone: "America/New_York",
      rrule: "FREQ=DAILY",
      dtstartLocal: "2026-03-07T02:30:00",
      nextOccurrenceAt: "2026-03-07T07:30:00.000Z",
      nextOccurrenceLocal: "2026-03-07T02:30:00",
    });

    enqueueDueWork(database.sqlite, {
      now: new Date("2026-03-08T07:31:00.000Z"),
    });

    const task = getTask(database, taskId);
    expect(task["next_occurrence_at"]).toBe("2026-03-09T06:30:00.000Z");
    expect(task["next_occurrence_local"]).toBe("2026-03-09T02:30:00");
    expect(count(database, "task_completions", "WHERE status = 'missed'")).toBe(2);
  });

  it("uses the first fold for a fall-back 01:30 recurrence", () => {
    const database = setup();
    insertSubscription(database);
    const taskId = insertTask(database, {
      title: "DST fold",
      timezone: "America/New_York",
      rrule: "FREQ=DAILY",
      dtstartLocal: "2026-10-31T01:30:00",
      nextOccurrenceAt: "2026-10-31T05:30:00.000Z",
      nextOccurrenceLocal: "2026-10-31T01:30:00",
    });

    enqueueDueWork(database.sqlite, {
      now: new Date("2026-11-01T05:31:00.000Z"),
    });

    const task = getTask(database, taskId);
    expect(task["next_occurrence_at"]).toBe("2026-11-02T06:30:00.000Z");
    expect(task["next_occurrence_local"]).toBe("2026-11-02T01:30:00");
  });
});

describe("scheduler claim / lease", () => {
  it("claims once, reclaims an expired lease, and rejects the stale token", () => {
    const database = setup();
    const taskId = insertTask(database, { priority: 1 });
    const deliveryId = insertDelivery(database, taskId);

    const first = claimDeliveries(database.sqlite, {
      now: new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(first).toHaveLength(1);
    expect(first[0]!.status).toBe("sending");
    expect(first[0]!.attempts).toBe(1);
    const staleToken = first[0]!.claim_token!;
    expect(staleToken).toBeTruthy();

    const again = claimDeliveries(database.sqlite, {
      now: new Date("2026-11-02T12:00:10.000Z"),
    });
    expect(again).toHaveLength(0);

    const reclaimed = claimDeliveries(database.sqlite, {
      now: new Date("2026-11-02T12:01:10.000Z"),
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.attempts).toBe(2);
    expect(reclaimed[0]!.claim_token).not.toBe(staleToken);

    expect(
      markSent(
        database.sqlite,
        deliveryId,
        staleToken,
        new Date("2026-11-02T12:01:11.000Z"),
      ),
    ).toBe(false);
    expect(getDelivery(database, deliveryId)["status"]).toBe("sending");

    expect(
      markSent(
        database.sqlite,
        deliveryId,
        reclaimed[0]!.claim_token!,
        new Date("2026-11-02T12:01:12.000Z"),
      ),
    ).toBe(true);
    expect(getDelivery(database, deliveryId)["status"]).toBe("sent");
  });

  it("leases the single scheduler writer and lets a later owner take over", () => {
    const database = setup();
    const now = new Date("2026-11-02T12:00:00.000Z");
    expect(acquireSchedulerLease(database.sqlite, "a", now, 60_000)).toBe(true);
    expect(acquireSchedulerLease(database.sqlite, "b", now, 60_000)).toBe(false);
    expect(
      acquireSchedulerLease(
        database.sqlite,
        "b",
        new Date("2026-11-02T12:01:01.000Z"),
        60_000,
      ),
    ).toBe(true);
    const state = database.sqlite
      .prepare("SELECT lease_owner FROM scheduler_state WHERE id = 1")
      .get() as { lease_owner: string };
    expect(state.lease_owner).toBe("b");
  });
});

describe("push delivery policy", () => {
  function claimedDelivery(database: MorrowDatabase): ClaimedDelivery {
    const taskId = insertTask(database, { priority: 1 });
    insertDelivery(database, taskId);
    const claimed = claimDeliveries(database.sqlite, {
      now: new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(claimed).toHaveLength(1);
    return claimed[0]!;
  }

  it("410 disables the subscription and dead-letters the delivery", async () => {
    const database = setup();
    insertSubscription(database);
    const delivery = claimedDelivery(database);

    const result = await processDelivery(database.sqlite, delivery, {
      now: new Date("2026-11-02T12:00:01.000Z"),
      config: PUSH_CONFIG,
      transport: failingTransport({ statusCode: 410, message: "Gone" }),
    });

    expect(result.status).toBe("dead");
    expect(getDelivery(database, delivery.id)["status"]).toBe("dead");
    const subscription = database.sqlite
      .prepare("SELECT enabled FROM push_subscriptions WHERE id = ?")
      .get(SUB_ID) as { enabled: number };
    expect(subscription.enabled).toBe(0);
  });

  it("429 honours Retry-After and returns the row to retry", async () => {
    const database = setup();
    insertSubscription(database);
    const delivery = claimedDelivery(database);

    const result = await processDelivery(database.sqlite, delivery, {
      now: new Date("2026-11-02T12:00:01.000Z"),
      config: PUSH_CONFIG,
      transport: failingTransport({
        statusCode: 429,
        headers: { "retry-after": "120" },
        message: "Too many requests",
      }),
    });

    expect(result.status).toBe("retry");
    expect(result.retryAt).toBe("2026-11-02T12:02:01.000Z");
    const row = getDelivery(database, delivery.id);
    expect(row["status"]).toBe("retry");
    expect(row["next_attempt_at"]).toBe("2026-11-02T12:02:01.000Z");
    expect(row["claim_token"]).toBeNull();
  });

  it("backs off a 5xx delivery with exponential delay", async () => {
    const database = setup();
    insertSubscription(database);
    const taskId = insertTask(database, { priority: 1 });
    insertDelivery(database, taskId);
    const claimed = claimDeliveries(database.sqlite, {
      now: new Date("2026-11-02T12:00:00.000Z"),
    });

    const result = await processDelivery(database.sqlite, claimed[0]!, {
      now: new Date("2026-11-02T12:00:01.000Z"),
      config: PUSH_CONFIG,
      transport: failingTransport({ statusCode: 503, message: "Unavailable" }),
    });

    expect(result.status).toBe("retry");
    expect(result.retryAt).toBe("2026-11-02T12:00:31.000Z");
  });

  it("5xx backs off exponentially and five attempts dead-letter", async () => {
    const database = setup();
    insertSubscription(database);
    const taskId = insertTask(database, { priority: 1 });
    insertDelivery(database, taskId, { attempts: 4 });
    const claimed = claimDeliveries(database.sqlite, {
      now: new Date("2026-11-02T12:00:00.000Z"),
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.attempts).toBe(5);

    const result = await processDelivery(database.sqlite, claimed[0]!, {
      now: new Date("2026-11-02T12:00:01.000Z"),
      config: PUSH_CONFIG,
      transport: failingTransport({ statusCode: 503, message: "Unavailable" }),
    });

    expect(result.status).toBe("dead");
    expect(getDelivery(database, claimed[0]!.id)["status"]).toBe("dead");
  });

  it("runs a full tick: enqueue, claim, send, and ledger activity", async () => {
    const database = setup();
    insertSubscription(database);
    const taskId = insertTask(database, {
      title: "Tick end to end",
      nextOccurrenceAt: "2026-11-02T12:00:00.000Z",
      nextOccurrenceLocal: "2026-11-02T12:00:00",
    });

    const result = await runSchedulerTick(database.sqlite, {
      now: new Date("2026-11-02T12:00:05.000Z"),
      owner: "test-owner",
      pushOptions: {
        config: PUSH_CONFIG,
        transport: {
          async send() {
            return { statusCode: 201 };
          },
        },
      },
    });

    expect(result.enqueued.deliveriesInserted).toBe(1);
    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    const delivery = database.sqlite
      .prepare("SELECT status, sent_at FROM deliveries WHERE task_id = ?")
      .get(taskId) as { status: string; sent_at: string | null };
    expect(delivery.status).toBe("sent");
    expect(delivery.sent_at).toBe("2026-11-02T12:00:05.000Z");
    expect(
      count(database, "activity", "WHERE action = 'delivery.sent'"),
    ).toBe(1);
  });

  it("marks stale claims as stale instead of overwriting sent", async () => {
    const database = setup();
    insertSubscription(database);
    const taskId = insertTask(database, { priority: 1 });
    insertDelivery(database, taskId);
    const claimed = claimDeliveries(database.sqlite, {
      now: new Date("2026-11-02T12:00:00.000Z"),
    });
    // Simulate a concurrent reclaim: clear/replace the token before send.
    database.sqlite
      .prepare("UPDATE deliveries SET claim_token = 'new-token' WHERE id = ?")
      .run(claimed[0]!.id);

    const result = await processDelivery(database.sqlite, claimed[0]!, {
      now: new Date("2026-11-02T12:00:01.000Z"),
      config: PUSH_CONFIG,
      transport: {
        async send() {
          return { statusCode: 201 };
        },
      },
    });

    expect(result.status).toBe("stale");
    expect(getDelivery(database, claimed[0]!.id)["status"]).toBe("sending");
  });
});

describe("push payload / endpoint guards", () => {
  it("keeps the serialized payload under 2 KB", () => {
    const payload = serializePushPayload({
      title: "A very long title ".repeat(200),
      body: "A very long body ".repeat(1000),
      url: "/tasks/01900000-0000-7000-8000-000000000001",
      taskId: "01900000-0000-7000-8000-000000000001",
      deliveryId: "01900000-0000-7000-8000-0000000000bb",
      tag: "abc123",
      badgeCount: 3,
      kind: "reminder",
    });
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(2048);
  });

  it("includes the task revision for notification actions", () => {
    const payload = JSON.parse(
      serializePushPayload({
        title: "Stand up",
        body: "Reminder due now",
        url: "/tasks/task-1",
        taskId: "task-1",
        taskRev: 7,
        deliveryId: "delivery-1",
        kind: "reminder",
      }),
    ) as { taskRev?: number; taskId?: string };
    expect(payload.taskId).toBe("task-1");
    expect(payload.taskRev).toBe(7);
  });

  it("rejects private, loopback, non-HTTPS, and unknown push hosts", () => {
    expect(() =>
      validatePushEndpoint("https://fcm.googleapis.com/fcm/send/x"),
    ).not.toThrow();
    expect(() => validatePushEndpoint("http://fcm.googleapis.com/fcm/send/x")).toThrow(
      /HTTPS/,
    );
    expect(() => validatePushEndpoint("https://127.0.0.1/push")).toThrow(
      /public/,
    );
    expect(() => validatePushEndpoint("https://[::1]/push")).toThrow(/public/);
    expect(() =>
      validatePushEndpoint("https://[::ffff:127.0.0.1]/push"),
    ).toThrow(/public/);
    expect(() => validatePushEndpoint("https://169.254.169.254/latest")).toThrow(
      /public/,
    );
    expect(() => validatePushEndpoint("https://example.com/push")).toThrow(
      /recognised/,
    );
  });

  it("documents the digest downtime threshold", () => {
    expect(DIGEST_DOWNTIME_MS).toBe(30 * 60 * 1000);
  });

  it("builds a 15-minute Topic within the 32-char base64url limit", () => {
    const first = pushTopic("batch", SUB_ID, "reminder", batchBucket(new Date("2026-11-02T12:00:00.000Z")));
    const second = pushTopic("batch", SUB_ID, "reminder", batchBucket(new Date("2026-11-02T12:14:59.000Z")));
    const next = pushTopic("batch", SUB_ID, "reminder", batchBucket(new Date("2026-11-02T12:15:00.000Z")));
    expect(first).toBe(second);
    expect(first).not.toBe(next);
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(first.length).toBeLessThanOrEqual(32);
  });
});
