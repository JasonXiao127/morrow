/**
 * M1 tasks + search tests (§5 contract, §9 views, §11 M1).
 *
 * Covers: client-UUID create, idempotent replay, tombstone 409, 428/412,
 * ETag bumps, GET 410, complete idempotency (+ recurring advance), Today
 * excluding done, view partitioning, cursor pagination, snooze/skip, and
 * search title ranking.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { closeDb, getDb } from "@morrow/db";
import { newId } from "@morrow/shared";
import { resetConfigCache } from "../src/config.js";
import { buildApp } from "../src/index.js";

const PASSWORD = "correct-horse-battery-staple-99";
const SETUP_TOKEN = "test-setup-token-tasks-01";

let dir = "";
let app: FastifyInstance;
let cookie = "";
const savedEnv: Record<string, string | undefined> = {};

function isoIn(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  expect(first).toBeTruthy();
  return String(first).split(";")[0] as string;
}

async function api(
  method: string,
  url: string,
  opts: { payload?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: { cookie, ...(opts.headers ?? {}) },
    payload: opts.payload,
  });
  return res;
}

const revOf = (res: { headers: Record<string, unknown> }): string | undefined =>
  res.headers["etag"] as string | undefined;

function itemsOf<T = Record<string, unknown>>(body: unknown): T[] {
  const row = (body ?? {}) as { items?: T[]; tasks?: T[] };
  return row.items ?? row.tasks ?? [];
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDay(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function insertPendingDelivery(
  taskId: string,
  occurrenceKey: string,
  id: string = newId(),
): string {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO deliveries
         (id, task_id, occurrence_key, kind, channel, subscription_id,
          status, attempts, rev, created_at, updated_at)
       VALUES (?, ?, ?, 'reminder', 'webpush', '', 'pending', 0, 1, ?, ?)`,
    )
    .run(id, taskId, occurrenceKey, now, now);
  return id;
}

function pendingCount(taskId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM deliveries
        WHERE task_id = ? AND status IN ('pending', 'retry')`,
    )
    .get(taskId) as { n: number };
  return row.n;
}

beforeAll(async () => {
  for (const k of ["DATABASE_PATH", "SETUP_TOKEN", "APP_URL", "SECRETS_DIR"]) {
    savedEnv[k] = process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "morrow-m1-tasks-"));
  process.env["DATABASE_PATH"] = join(dir, "morrow.db");
  process.env["SETUP_TOKEN"] = SETUP_TOKEN;
  process.env["APP_URL"] = "http://localhost:3000";
  process.env["SECRETS_DIR"] = join(dir, "secrets");
  resetConfigCache();
  closeDb();
  app = await buildApp();
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { token: SETUP_TOKEN, password: PASSWORD, timezone: "UTC" },
  });
  expect(setup.statusCode).toBe(201);
  cookie = cookieOf(setup);
});

afterAll(async () => {
  try {
    await app.close();
  } catch {
    // ignore
  }
  closeDb();
  resetConfigCache();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/tasks", () => {
  it("creates with a client UUID (201 + ETag rev-1)", async () => {
    const id = newId();
    const res = await api("POST", "/api/tasks", {
      payload: { id, title: "Write report" },
      headers: { "idempotency-key": id },
    });
    expect(res.statusCode).toBe(201);
    expect(revOf(res)).toBe('"rev-1"');
    const body = res.json() as Record<string, unknown>;
    expect(body["id"]).toBe(id);
    expect(body["rev"]).toBe(1);
    expect(body["title"]).toBe("Write report");
  });

  it("replays the same result for the same client UUID", async () => {
    const id = newId();
    const first = await api("POST", "/api/tasks", {
      payload: { id, title: "Replay me" },
    });
    expect(first.statusCode).toBe(201);
    const second = await api("POST", "/api/tasks", {
      payload: { id, title: "Replay me" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json()).toEqual(first.json());
  });

  it("returns 409 when the UUID is a tombstone", async () => {
    const id = newId();
    const created = await api("POST", "/api/tasks", {
      payload: { id, title: "Doomed" },
    });
    expect(created.statusCode).toBe(201);
    const deleted = await api("DELETE", `/api/tasks/${id}`, {
      headers: { "if-match": '"rev-1"' },
    });
    expect(deleted.statusCode).toBe(200);
    const retry = await api("POST", "/api/tasks", {
      payload: { id, title: "Doomed again" },
    });
    expect(retry.statusCode).toBe(409);
    expect((retry.json() as { code?: string }).code).toBe("tombstoned");
    const conflictBody = retry.json() as {
      current?: { id?: string; rev?: number; updatedAt?: string; title?: string };
    };
    expect(conflictBody.current).toMatchObject({
      id,
      rev: 2,
      title: "Doomed",
    });
    expect(typeof conflictBody.current?.updatedAt).toBe("string");
    expect(revOf(retry)).toBe('"rev-2"');
  });
});

describe("concurrency (428/412 + ETag)", () => {
  it("PATCH without If-Match → 428", async () => {
    const id = newId();
    await api("POST", "/api/tasks", { payload: { id, title: "Guarded" } });
    const res = await api("PATCH", `/api/tasks/${id}`, {
      payload: { title: "Guarded edit" },
    });
    expect(res.statusCode).toBe(428);
    expect((res.json() as { code?: string }).code).toBe("precondition_required");
  });

  it("PATCH stale rev → 412 with the current ETag; fresh rev wins", async () => {
    const id = newId();
    await api("POST", "/api/tasks", { payload: { id, title: "Versioned" } });
    const ok = await api("PATCH", `/api/tasks/${id}`, {
      payload: { title: "Versioned v2" },
      headers: { "if-match": '"rev-1"' },
    });
    expect(ok.statusCode).toBe(200);
    expect(revOf(ok)).toBe('"rev-2"');
    expect((ok.json() as { rev?: number }).rev).toBe(2);

    const stale = await api("PATCH", `/api/tasks/${id}`, {
      payload: { title: "Versioned stale" },
      headers: { "if-match": '"rev-1"' },
    });
    expect(stale.statusCode).toBe(412);
    expect(revOf(stale)).toBe('"rev-2"');
    const staleBody = stale.json() as {
      current?: { id?: string; rev?: number; updatedAt?: string; title?: string };
    };
    expect(staleBody.current).toMatchObject({
      id,
      rev: 2,
      title: "Versioned v2",
    });
    expect(typeof staleBody.current?.updatedAt).toBe("string");
  });

  it("GET one carries ETag; deleted reads 410", async () => {
    const id = newId();
    await api("POST", "/api/tasks", { payload: { id, title: "Readable" } });
    const got = await api("GET", `/api/tasks/${id}`);
    expect(got.statusCode).toBe(200);
    expect(revOf(got)).toBe('"rev-1"');
    await api("DELETE", `/api/tasks/${id}`, {
      headers: { "if-match": '"rev-1"' },
    });
    const goneRes = await api("GET", `/api/tasks/${id}`);
    expect(goneRes.statusCode).toBe(410);
  });
});

describe("complete / snooze / skip", () => {
  it("complete requires If-Match and is idempotent per occurrenceKey", async () => {
    const id = newId();
    const dueAt = isoIn(3_600_000);
    await api("POST", "/api/tasks", { payload: { id, title: "Finish me", dueAt } });

    const missing = await api("POST", `/api/tasks/${id}/complete`, {
      payload: { occurrenceKey: dueAt },
    });
    expect(missing.statusCode).toBe(428);
    expect((missing.json() as { code?: string }).code).toBe(
      "precondition_required",
    );

    const first = await api("POST", `/api/tasks/${id}/complete`, {
      payload: { occurrenceKey: dueAt },
      headers: { "if-match": '"rev-1"' },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { status?: string }).status).toBe("done");

    // Same occurrence replays even with the now-stale original ETag.
    const second = await api("POST", `/api/tasks/${id}/complete`, {
      payload: { occurrenceKey: dueAt },
      headers: { "if-match": '"rev-1"' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json()).toEqual(first.json());
  });

  it("complete with a stale rev → 412 + current representation", async () => {
    const id = newId();
    await api("POST", "/api/tasks", { payload: { id, title: "Stale complete" } });
    const patched = await api("PATCH", `/api/tasks/${id}`, {
      payload: { title: "Stale complete v2" },
      headers: { "if-match": '"rev-1"' },
    });
    expect(patched.statusCode).toBe(200);

    const stale = await api("POST", `/api/tasks/${id}/complete`, {
      payload: {},
      headers: { "if-match": '"rev-1"' },
    });
    expect(stale.statusCode).toBe(412);
    expect(revOf(stale)).toBe('"rev-2"');
    const body = stale.json() as {
      current?: { id?: string; rev?: number; updatedAt?: string; title?: string };
    };
    expect(body.current).toMatchObject({
      id,
      rev: 2,
      title: "Stale complete v2",
    });
    expect(typeof body.current?.updatedAt).toBe("string");
  });

  it("completing a recurring series advances instead of closing", async () => {
    const id = newId();
    const today = new Date().toISOString().slice(0, 10);
    const dueAt = `${today}T09:00:00.000Z`;
    const created = await api("POST", "/api/tasks", {
      payload: {
        id,
        title: "Daily standup",
        dueAt,
        rrule: "FREQ=DAILY",
        dtstartLocal: `${today}T09:00:00`,
        timezone: "UTC",
      },
    });
    expect(created.statusCode).toBe(201);
    const done = await api("POST", `/api/tasks/${id}/complete`, {
      payload: {},
      headers: { "if-match": '"rev-1"' },
    });
    expect(done.statusCode).toBe(200);
    const body = done.json() as Record<string, unknown>;
    expect(body["status"]).toBe("open");
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(body["next_occurrence_at"]).toBe(`${tomorrow}T09:00:00.000Z`);
  });

  it("does not rewind a recurring series when only reminder fields change", async () => {
    const id = newId();
    const today = new Date().toISOString().slice(0, 10);
    await api("POST", "/api/tasks", {
      payload: {
        id,
        title: "Keep the series",
        dueAt: `${today}T09:00:00.000Z`,
        rrule: "FREQ=DAILY",
        dtstartLocal: `${today}T09:00:00`,
        timezone: "UTC",
      },
    });
    const completed = await api("POST", `/api/tasks/${id}/complete`, {
      payload: {},
      headers: { "if-match": '"rev-1"' },
    });
    expect(completed.statusCode).toBe(200);
    const advanced = completed.json() as {
      next_occurrence_at: string;
      rev: number;
    };
    const nextOccurrence = advanced.next_occurrence_at;
    const patched = await api("PATCH", `/api/tasks/${id}`, {
      payload: { remindOffsetMinutes: -30 },
      headers: { "if-match": `"rev-${advanced.rev}"` },
    });
    expect(patched.statusCode).toBe(200);
    const body = patched.json() as { next_occurrence_at?: string };
    expect(body.next_occurrence_at).toBe(nextOccurrence);
  });

  it("snooze requires If-Match and bumps rev", async () => {
    const id = newId();
    await api("POST", "/api/tasks", { payload: { id, title: "Snoozable" } });
    const until = isoIn(7_200_000);
    const missing = await api("POST", `/api/tasks/${id}/snooze`, {
      payload: { until },
    });
    expect(missing.statusCode).toBe(428);
    const ok = await api("POST", `/api/tasks/${id}/snooze`, {
      payload: { until },
      headers: { "if-match": '"rev-1"' },
    });
    expect(ok.statusCode).toBe(200);
    expect(revOf(ok)).toBe('"rev-2"');
    expect((ok.json() as { snoozed_until?: string }).snoozed_until).toBe(until);
  });

  it("snooze to the past → 400", async () => {
    const id = newId();
    await api("POST", "/api/tasks", { payload: { id, title: "No past snooze" } });
    const res = await api("POST", `/api/tasks/${id}/snooze`, {
      payload: { until: isoIn(-3_600_000) },
      headers: { "if-match": '"rev-1"' },
    });
    expect(res.statusCode).toBe(400);
  });

  it("skip requires If-Match and replays a one-shot cancellation", async () => {
    const id = newId();
    await api("POST", "/api/tasks", { payload: { id, title: "Skippable" } });

    const missing = await api("POST", `/api/tasks/${id}/skip`, { payload: {} });
    expect(missing.statusCode).toBe(428);

    const first = await api("POST", `/api/tasks/${id}/skip`, {
      payload: {},
      headers: { "if-match": '"rev-1"' },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { status?: string }).status).toBe("cancelled");

    const second = await api("POST", `/api/tasks/${id}/skip`, {
      payload: {},
      headers: { "if-match": '"rev-1"' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
  });
});

describe("delivery cancellation on state change", () => {
  it("cancels pending deliveries and records activity for complete/snooze/skip/delete", async () => {
    const actions: Array<{
      name: "complete" | "snooze" | "skip" | "delete";
      activity: string;
    }> = [
      { name: "complete", activity: "task.complete" },
      { name: "snooze", activity: "task.snooze" },
      { name: "skip", activity: "task.skip" },
      { name: "delete", activity: "task.delete" },
    ];

    for (const action of actions) {
      const id = newId();
      await api("POST", "/api/tasks", {
        payload: { id, title: `Cancel ${action.name}`, dueAt: isoIn(3_600_000) },
      });
      insertPendingDelivery(id, isoIn(3_600_000));
      insertPendingDelivery(id, isoIn(7_200_000));
      expect(pendingCount(id)).toBe(2);

      const res =
        action.name === "snooze"
          ? await api("POST", `/api/tasks/${id}/snooze`, {
              payload: { until: isoIn(7_200_000) },
              headers: { "if-match": '"rev-1"' },
            })
          : action.name === "delete"
            ? await api("DELETE", `/api/tasks/${id}`, {
                headers: { "if-match": '"rev-1"' },
              })
            : await api("POST", `/api/tasks/${id}/${action.name}`, {
                payload: {},
                headers: { "if-match": '"rev-1"' },
              });
      expect(res.statusCode).toBe(200);
      expect(pendingCount(id)).toBe(0);
      const activity = getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM activity
            WHERE entity_id = ? AND action = ?`,
        )
        .get(id, action.activity) as { n: number };
      expect(activity.n).toBeGreaterThan(0);
    }
  });
});

describe("all-day recurring grouping", () => {
  it("places an all-day daily series in Today by next_occurrence_local", async () => {
    const id = newId();
    const today = todayKey();
    const created = await api("POST", "/api/tasks", {
      payload: {
        id,
        title: "all-day-daily-today",
        allDay: true,
        dueDate: shiftDay(-5),
        rrule: "FREQ=DAILY",
        dtstartLocal: shiftDay(-5),
        reminderTimeLocal: "09:00:00",
        nextOccurrenceLocal: today,
        timezone: "UTC",
      },
    });
    expect(created.statusCode).toBe(201);

    const res = await api("GET", "/api/tasks?view=today&limit=200");
    expect(res.statusCode).toBe(200);
    const ids = itemsOf<{ id: string }>(res.json()).map((t) => t.id);
    expect(ids).toContain(id);
  });

  it("does not keep a past due_date in Today after the series moved on", async () => {
    const id = newId();
    const created = await api("POST", "/api/tasks", {
      payload: {
        id,
        title: "all-day-daily-upcoming",
        allDay: true,
        dueDate: shiftDay(-1),
        rrule: "FREQ=DAILY",
        dtstartLocal: shiftDay(-1),
        reminderTimeLocal: "09:00:00",
        nextOccurrenceLocal: shiftDay(1),
        timezone: "UTC",
      },
    });
    expect(created.statusCode).toBe(201);

    const todayRes = await api("GET", "/api/tasks?view=today&limit=200");
    const todayIds = itemsOf<{ id: string }>(todayRes.json()).map((t) => t.id);
    expect(todayIds).not.toContain(id);

    const upcoming = await api("GET", "/api/tasks?view=upcoming&limit=200");
    const upcomingIds = itemsOf<{ id: string }>(upcoming.json()).map((t) => t.id);
    expect(upcomingIds).toContain(id);
  });
});

describe("views + pagination", () => {
  it("Today contains open due tasks but excludes done", async () => {
    const openId = newId();
    const doneId = newId();
    const dueAt = isoIn(-60_000);
    await api("POST", "/api/tasks", {
      payload: { id: openId, title: "today-open-marker", dueAt },
    });
    await api("POST", "/api/tasks", {
      payload: { id: doneId, title: "today-done-marker", dueAt },
    });
    await api("POST", `/api/tasks/${doneId}/complete`, {
      payload: {},
      headers: { "if-match": '"rev-1"' },
    });
    const res = await api("GET", "/api/tasks?view=today&limit=200");
    expect(res.statusCode).toBe(200);
    const ids = itemsOf<{ id: string }>(res.json()).map((t) => t.id);
    expect(ids).toContain(openId);
    expect(ids).not.toContain(doneId);
  });

  it("upcoming/inbox partition by day key", async () => {
    const futureId = newId();
    const undatedId = newId();
    await api("POST", "/api/tasks", {
      payload: { id: futureId, title: "future-marker", dueAt: isoIn(30 * 86_400_000) },
    });
    await api("POST", "/api/tasks", {
      payload: { id: undatedId, title: "undated-marker" },
    });
    const upcoming = await api("GET", "/api/tasks?view=upcoming&limit=200");
    const upcomingIds = itemsOf<{ id: string }>(upcoming.json()).map((t) => t.id);
    expect(upcomingIds).toContain(futureId);
    expect(upcomingIds).not.toContain(undatedId);

    const inbox = await api("GET", "/api/tasks?view=inbox&limit=200");
    const inboxIds = itemsOf<{ id: string }>(inbox.json()).map((t) => t.id);
    expect(inboxIds).toContain(undatedId);
    expect(inboxIds).not.toContain(futureId);
  });

  it("cursor pagination pages and terminates", async () => {
    const listRes = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Page list" },
    });
    const listId = (listRes.json() as { id: string }).id;
    for (let i = 0; i < 3; i += 1) {
      await api("POST", "/api/tasks", {
        payload: { id: newId(), title: `page-item-${i}`, listId },
      });
    }
    const first = await api(
      "GET",
      `/api/tasks?view=all&listId=${listId}&limit=2`,
    );
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      items?: unknown[];
      tasks?: unknown[];
      cursor?: string | null;
      next?: string | null;
      nextCursor?: string | null;
      hasMore?: boolean;
    };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.tasks).toHaveLength(2);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.next).not.toBeNull();
    expect(firstBody.cursor).toBe(firstBody.next);
    const second = await api(
      "GET",
      `/api/tasks?view=all&listId=${listId}&limit=2&cursor=${firstBody.next}`,
    );
    const secondBody = second.json() as {
      items?: unknown[];
      cursor?: string | null;
      next?: string | null;
      hasMore?: boolean;
      nextCursor?: string | null;
    };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.next).toBeNull();
    expect(secondBody.nextCursor).toBeNull();
    expect(secondBody.hasMore).toBe(false);
  });

  it("filters, orders, and pages 500 tasks in SQL (one query per page)", async () => {
    const listRes = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Perf list" },
    });
    const listId = (listRes.json() as { id: string }).id;
    const userId = (
      getDb().prepare("SELECT id FROM users LIMIT 1").get() as { id: string }
    ).id;
    const now = new Date().toISOString();
    const base = Date.now() + 86_400_000;
    const expected: string[] = [];
    const insert = getDb().prepare(
      `INSERT INTO tasks
         (id, user_id, list_id, title, status, priority, due_at, all_day,
          recurrence_mode, clamp_policy, occurrence_seq, missed_count,
          sort_key, rev, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 0, 'schedule', 'skip', 0, 0, '', 1, ?, ?, NULL)`,
    );
    const seed = getDb().transaction(() => {
      // Every tenth row is done: the upcoming view must exclude these in SQL.
      for (let i = 0; i < 500; i += 1) {
        const id = newId();
        if (i % 10 !== 0) expected.push(id);
        insert.run(
          id,
          userId,
          listId,
          `perf-${String(i).padStart(3, "0")}`,
          i % 10 === 0 ? "done" : "open",
          new Date(base + i * 60_000).toISOString(),
          now,
          now,
        );
      }
      // Undated open task: belongs to inbox, never to upcoming.
      insert.run(
        newId(),
        userId,
        listId,
        "perf-inbox",
        "open",
        null,
        now,
        now,
      );
    });
    seed();

    const db = getDb();
    const originalPrepare = db.prepare.bind(db);
    let taskListQueries = 0;
    let taskListSql = "";
    const mutable = db as unknown as {
      prepare: (sql: string) => ReturnType<typeof db.prepare>;
    };
    mutable.prepare = ((sql: string) => {
      if (sql.includes("FROM tasks") && sql.includes("ORDER BY")) {
        taskListQueries += 1;
        taskListSql = sql;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;
    try {
      const first = await api(
        "GET",
        `/api/tasks?view=upcoming&listId=${listId}&limit=20`,
      );
      expect(first.statusCode).toBe(200);
      const firstBody = first.json() as {
        items?: Array<{ id: string }>;
        cursor?: string | null;
        next?: string | null;
      };
      expect(firstBody.items?.map((t) => t.id)).toEqual(expected.slice(0, 20));
      expect(firstBody.next).toBe("20");

      const second = await api(
        "GET",
        `/api/tasks?view=upcoming&listId=${listId}&limit=20&cursor=${firstBody.next}`,
      );
      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as {
        items?: Array<{ id: string }>;
        cursor?: string | null;
        next?: string | null;
        hasMore?: boolean;
      };
      expect(secondBody.items?.map((t) => t.id)).toEqual(
        expected.slice(20, 40),
      );
      expect(secondBody.next).toBe("40");
      expect(secondBody.hasMore).toBe(true);
      expect(secondBody.items?.some((t) => t.id === expected[0])).toBe(false);
    } finally {
      mutable.prepare = originalPrepare;
    }
    // One tasks SELECT per page request: no per-row queries and no full-table
    // materialisation followed by JS sorting.
    expect(taskListQueries).toBe(2);
    expect(taskListSql).toContain("list_id = ?");
    expect(taskListSql).toContain("LIMIT ? OFFSET ?");
    expect(taskListSql).toContain("morrow_task_day_key");
    expect(taskListSql).toContain("morrow_task_sort_ms");
  });
});

describe("GET /api/search", () => {
  it("ranks title matches before notes matches", async () => {
    const titleId = newId();
    const notesId = newId();
    await api("POST", "/api/tasks", {
      payload: { id: titleId, title: "oat milk latte", notes: "unrelated" },
    });
    await api("POST", "/api/tasks", {
      payload: { id: notesId, title: "Errands", notes: "buy oat milk latte beans" },
    });
    const res = await api("GET", "/api/search?q=oat%20milk");
    expect(res.statusCode).toBe(200);
    const tasks = itemsOf<{ id: string }>(res.json());
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(tasks[0]?.id).toBe(titleId);
    expect(tasks.map((t) => t.id)).toContain(notesId);
  });

  it("pages with the canonical {items,cursor,next} shape", async () => {
    const marker = `search-page-${newId()}`;
    const ids = [newId(), newId(), newId()];
    for (const id of ids) {
      await api("POST", "/api/tasks", {
        payload: { id, title: `${marker} result`, notes: marker },
      });
    }

    const first = await api("GET", `/api/search?q=${marker}&limit=2`);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      items?: Array<{ id: string }>;
      cursor?: string | null;
      next?: string | null;
      nextCursor?: string | null;
      hasMore?: boolean;
    };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.next).not.toBeNull();
    expect(firstBody.cursor).toBe(firstBody.next);

    const second = await api(
      "GET",
      `/api/search?q=${marker}&limit=2&cursor=${firstBody.next}`,
    );
    const secondBody = second.json() as {
      items?: Array<{ id: string }>;
      next?: string | null;
      hasMore?: boolean;
    };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.next).toBeNull();
    expect(secondBody.hasMore).toBe(false);
    const seen = [...(firstBody.items ?? []), ...(secondBody.items ?? [])].map(
      (t) => t.id,
    );
    expect(new Set(seen).size).toBe(3);
  });

  it("empty query returns no results", async () => {
    const res = await api("GET", "/api/search?q=");
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items?: unknown[];
      tasks?: unknown[];
      next?: string | null;
      cursor?: string | null;
    };
    expect(body.items).toEqual([]);
    expect(body.tasks).toEqual([]);
    expect(body.next).toBeNull();
    expect(body.cursor).toBeNull();
  });
});
