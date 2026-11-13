/**
 * M1 lists tests (§5 contract, §11 M1).
 *
 * Covers: create + ETag, client-UUID replay, tombstone 409, 428/412,
 * rev bumps, soft delete semantics (unlinked members), and payload guards.
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
const SETUP_TOKEN = "test-setup-token-lists-01";

let dir = "";
let app: FastifyInstance;
let cookie = "";
const savedEnv: Record<string, string | undefined> = {};

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
  return app.inject({
    method: method as "GET",
    url,
    headers: { cookie, ...(opts.headers ?? {}) },
    payload: opts.payload,
  });
}

const revOf = (res: { headers: Record<string, unknown> }): string | undefined =>
  res.headers["etag"] as string | undefined;

beforeAll(async () => {
  for (const k of ["DATABASE_PATH", "SETUP_TOKEN", "APP_URL", "SECRETS_DIR"]) {
    savedEnv[k] = process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "morrow-m1-lists-"));
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

describe("POST /api/lists", () => {
  it("creates with ETag rev-1", async () => {
    const id = newId();
    const res = await api("POST", "/api/lists", {
      payload: { id, name: "Groceries" },
      headers: { "idempotency-key": id },
    });
    expect(res.statusCode).toBe(201);
    expect(revOf(res)).toBe('"rev-1"');
    const body = res.json() as Record<string, unknown>;
    expect(body["id"]).toBe(id);
    expect(body["name"]).toBe("Groceries");
  });

  it("replays the same result for the same client UUID", async () => {
    const id = newId();
    const first = await api("POST", "/api/lists", {
      payload: { id, name: "Replay list" },
    });
    expect(first.statusCode).toBe(201);
    const second = await api("POST", "/api/lists", {
      payload: { id, name: "Replay list" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json()).toEqual(first.json());
  });

  it("rejects empty names and malformed ids", async () => {
    const empty = await api("POST", "/api/lists", {
      payload: { name: "  " },
    });
    expect(empty.statusCode).toBe(400);
    const badId = await api("POST", "/api/lists", {
      payload: { id: "not-a-uuid", name: "Bad id" },
    });
    expect(badId.statusCode).toBe(400);
  });
});

describe("GET /api/lists", () => {
  it("lists created lists in order", async () => {
    const id = newId();
    await api("POST", "/api/lists", { payload: { id, name: "Visible list" } });
    const res = await api("GET", "/api/lists");
    expect(res.statusCode).toBe(200);
    const ids = ((res.json() as { lists?: Array<{ id: string }> }).lists ?? []).map(
      (l) => l.id,
    );
    expect(ids).toContain(id);
  });
});

describe("PATCH / DELETE /api/lists/:id", () => {
  it("PATCH without If-Match → 428", async () => {
    const id = newId();
    await api("POST", "/api/lists", { payload: { id, name: "Guarded list" } });
    const res = await api("PATCH", `/api/lists/${id}`, {
      payload: { name: "Guarded edit" },
    });
    expect(res.statusCode).toBe(428);
  });

  it("PATCH stale rev → 412; fresh rev bumps and re-ETags", async () => {
    const id = newId();
    await api("POST", "/api/lists", { payload: { id, name: "Versioned list" } });
    const ok = await api("PATCH", `/api/lists/${id}`, {
      payload: { name: "Versioned list v2" },
      headers: { "if-match": '"rev-1"' },
    });
    expect(ok.statusCode).toBe(200);
    expect(revOf(ok)).toBe('"rev-2"');
    expect((ok.json() as { name?: string }).name).toBe("Versioned list v2");

    const stale = await api("PATCH", `/api/lists/${id}`, {
      payload: { name: "stale" },
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
      title: "Versioned list v2",
    });
    expect(typeof staleBody.current?.updatedAt).toBe("string");
  });

  it("DELETE soft-deletes, hides the list, and tombstones the UUID", async () => {
    const id = newId();
    await api("POST", "/api/lists", { payload: { id, name: "Doomed list" } });
    const deleted = await api("DELETE", `/api/lists/${id}`, {
      headers: { "if-match": '"rev-1"' },
    });
    expect(deleted.statusCode).toBe(200);
    expect(revOf(deleted)).toBe('"rev-2"');

    const listed = await api("GET", "/api/lists");
    const ids = ((listed.json() as { lists?: Array<{ id: string }> }).lists ?? []).map(
      (l) => l.id,
    );
    expect(ids).not.toContain(id);

    const retry = await api("POST", "/api/lists", {
      payload: { id, name: "Doomed list again" },
    });
    expect(retry.statusCode).toBe(409);
    expect((retry.json() as { code?: string }).code).toBe("tombstoned");
    const conflictBody = retry.json() as {
      current?: { id?: string; rev?: number; updatedAt?: string; title?: string };
    };
    expect(conflictBody.current).toMatchObject({
      id,
      rev: 2,
      title: "Doomed list",
    });
    expect(typeof conflictBody.current?.updatedAt).toBe("string");
    expect(revOf(retry)).toBe('"rev-2"');
  });

  it("DELETE unlinks member tasks instead of stranding them", async () => {
    const listId = newId();
    await api("POST", "/api/lists", { payload: { id: listId, name: "Home" } });
    const taskId = newId();
    const created = await api("POST", "/api/tasks", {
      payload: { id: taskId, title: "Member task", listId },
    });
    expect(created.statusCode).toBe(201);
    const deleted = await api("DELETE", `/api/lists/${listId}`, {
      headers: { "if-match": '"rev-1"' },
    });
    expect(deleted.statusCode).toBe(200);
    const got = await api("GET", `/api/tasks/${taskId}`);
    expect(got.statusCode).toBe(200);
    expect((got.json() as { list_id?: string | null }).list_id).toBeNull();
  });

  it("DELETE returns a typed 409 when unlinking would collide in the Inbox", async () => {
    const owner = getDb()
      .prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
      .get() as { id: string };
    const listId = newId();
    await api("POST", "/api/lists", {
      payload: { id: listId, name: "Collision list" },
    });
    const now = new Date().toISOString();
    const insertTask = (
      id: string,
      list: string | null,
      uid: string,
      href: string,
    ): void => {
      getDb()
        .prepare(
          `INSERT INTO tasks
             (id, user_id, list_id, ical_uid, caldav_href, title, status,
              priority, all_day, recurrence_mode, clamp_policy, occurrence_seq,
              missed_count, sort_key, rev, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'Collision task', 'open', 0, 0, 'schedule',
                   'skip', 0, 0, 'V00000000000000', 1, ?, ?)`,
        )
        .run(id, owner.id, list, uid, href, now, now);
    };
    const listTaskId = newId();
    insertTask(listTaskId, listId, "collision@example.test", "collision.ics");
    const inboxTaskId = newId();
    insertTask(inboxTaskId, null, "collision@example.test", "collision.ics");

    const blocked = await api("DELETE", `/api/lists/${listId}`, {
      headers: { "if-match": '"rev-1"' },
    });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { code?: string }).code).toBe(
      "inbox_identity_conflict",
    );
    expect(
      (await api("GET", "/api/lists")).json() as {
        lists: Array<{ id: string }>;
      },
    ).toHaveProperty(
      "lists",
      expect.arrayContaining([expect.objectContaining({ id: listId })]),
    );
    const stillLinked = getDb()
      .prepare("SELECT list_id FROM tasks WHERE id = ?")
      .get(listTaskId) as { list_id: string | null };
    expect(stillLinked.list_id).toBe(listId);
    expect(
      getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM activity WHERE action = 'list.delete' AND entity_id = ?",
        )
        .get(listId),
    ).toEqual({ n: 0 });

    // Reassigning the same task to the Inbox is guarded by the same rule.
    const moveBlocked = await api("PATCH", `/api/tasks/${listTaskId}`, {
      headers: { "if-match": '"rev-1"' },
      payload: { listId: null },
    });
    expect(moveBlocked.statusCode).toBe(409);
    expect((moveBlocked.json() as { code?: string }).code).toBe(
      "collection_identity_conflict",
    );

    // Removing the blocker lets the same If-Match retry succeed.
    getDb()
      .prepare("UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, inboxTaskId);
    const retried = await api("DELETE", `/api/lists/${listId}`, {
      headers: { "if-match": '"rev-1"' },
    });
    expect(retried.statusCode).toBe(200);
    expect(
      (
        getDb()
          .prepare("SELECT list_id FROM tasks WHERE id = ?")
          .get(listTaskId) as { list_id: string | null }
      ).list_id,
    ).toBeNull();
  });

  it("DELETE rejects a collision with an exception href", async () => {
    const owner = getDb()
      .prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
      .get() as { id: string };
    const listId = newId();
    await api("POST", "/api/lists", {
      payload: { id: listId, name: "Exception collision list" },
    });
    const now = new Date().toISOString();
    const seriesTask = newId();
    getDb()
      .prepare(
        `INSERT INTO tasks
           (id, user_id, list_id, ical_uid, caldav_href, title, status,
            priority, all_day, recurrence_mode, clamp_policy, occurrence_seq,
            missed_count, sort_key, rev, created_at, updated_at)
         VALUES (?, ?, ?, 'series@example.test', 'series.ics', 'Series',
                 'open', 0, 0, 'schedule', 'skip', 0, 0,
                 'V00000000000000', 1, ?, ?)`,
      )
      .run(seriesTask, owner.id, listId, now, now);
    getDb()
      .prepare(
        `INSERT INTO task_recurrence_exceptions
           (id, task_id, user_id, recurrence_id, caldav_href, patch_json,
            status, created_at, updated_at)
         VALUES (?, ?, ?, '2026-11-03T09:00:00.000Z', 'shared-exception.ics',
                 '{}', 'cancelled', ?, ?)`,
      )
      .run(newId(), seriesTask, owner.id, now, now);
    const inboxTask = newId();
    getDb()
      .prepare(
        `INSERT INTO tasks
           (id, user_id, list_id, ical_uid, caldav_href, title, status,
            priority, all_day, recurrence_mode, clamp_policy, occurrence_seq,
            missed_count, sort_key, rev, created_at, updated_at)
         VALUES (?, ?, NULL, 'inbox-other@example.test', 'shared-exception.ics',
                 'Inbox task', 'open', 0, 0, 'schedule', 'skip', 0, 0,
                 'V00000000000000', 1, ?, ?)`,
      )
      .run(inboxTask, owner.id, now, now);

    const blocked = await api("DELETE", `/api/lists/${listId}`, {
      headers: { "if-match": '"rev-1"' },
    });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { code?: string }).code).toBe(
      "inbox_identity_conflict",
    );
    expect(
      (
        getDb()
          .prepare("SELECT list_id FROM tasks WHERE id = ?")
          .get(seriesTask) as { list_id: string | null }
      ).list_id,
    ).toBe(listId);

    const moveBlocked = await api("PATCH", `/api/tasks/${seriesTask}`, {
      headers: { "if-match": '"rev-1"' },
      payload: { listId: null },
    });
    expect(moveBlocked.statusCode).toBe(409);
    expect((moveBlocked.json() as { code?: string }).code).toBe(
      "collection_identity_conflict",
    );
  });

  it("ignores a client isInbox flag so the virtual Inbox stays singular", async () => {
    const id = newId();
    const res = await api("POST", "/api/lists", {
      payload: { id, name: "Fake inbox", isInbox: true },
    });
    expect(res.statusCode).toBe(201);
    const row = getDb()
      .prepare("SELECT is_inbox FROM lists WHERE id = ?")
      .get(id) as { is_inbox: number };
    expect(row.is_inbox).toBe(0);
  });

  it("DELETE without If-Match → 428", async () => {
    const id = newId();
    await api("POST", "/api/lists", { payload: { id, name: "Keep me" } });
    const res = await api("DELETE", `/api/lists/${id}`);
    expect(res.statusCode).toBe(428);
  });
});
