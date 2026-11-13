/**
 * Route-level undo regressions: task delete, completion/skip, list
 * share/unshare, list-delete membership restore, and the purge boundary.
 * These exercise the real Fastify routes + activity log instead of calling
 * undoActivity directly, so snapshot shapes written by the routes stay in
 * sync with the undo reader.
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

const PASSWORD = "correct-horse-battery-staple-undo-01";
const PARTNER_PASSWORD = "another-long-password-undo-01";
const SETUP_TOKEN = "test-setup-token-undo-01";

let dir = "";
let app: FastifyInstance;
let cookie = "";
let partnerId = "";
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

async function stepUp(): Promise<void> {
  const res = await api("POST", "/api/auth/password", {
    payload: { password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
}

async function latestActivity(
  action: string,
  entityId: string,
): Promise<number> {
  const res = await api("GET", "/api/activity?cursor=0&limit=500");
  expect(res.statusCode).toBe(200);
  const rows = (
    res.json() as {
      activities?: Array<{
        seq: number;
        action: string;
        entityId: string;
      }>;
    }
  ).activities ?? [];
  const matches = rows
    .filter((row) => row.action === action && row.entityId === entityId)
    .sort((a, b) => b.seq - a.seq);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!.seq;
}

async function undo(seq: number) {
  return api("POST", `/api/activity/${seq}/undo`);
}

function completionRows(taskId: string): Array<{
  id: string;
  status: string;
  deleted_at: string | null;
}> {
  return getDb()
    .prepare(
      "SELECT id, status, deleted_at FROM task_completions WHERE task_id = ? ORDER BY created_at ASC",
    )
    .all(taskId) as Array<{
    id: string;
    status: string;
    deleted_at: string | null;
  }>;
}

beforeAll(async () => {
  for (const k of ["DATABASE_PATH", "SETUP_TOKEN", "APP_URL", "SECRETS_DIR"]) {
    savedEnv[k] = process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "morrow-undo-"));
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

  await stepUp();
  const partner = await api("POST", "/api/users", {
    payload: {
      username: "undo-partner",
      password: PARTNER_PASSWORD,
      timezone: "UTC",
    },
  });
  expect(partner.statusCode).toBe(201);
  partnerId = (partner.json() as { user: { id: string } }).user.id;
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

describe("task delete undo", () => {
  it("restores a deleted task as open and visible", async () => {
    const id = newId();
    const created = await api("POST", "/api/tasks", {
      payload: { id, title: "Restore me" },
    });
    expect(created.statusCode).toBe(201);

    const deleted = await api("DELETE", `/api/tasks/${id}`, {
      headers: { "if-match": '"rev-1"' },
    });
    expect(deleted.statusCode).toBe(200);
    expect((await api("GET", `/api/tasks/${id}`)).statusCode).toBe(410);

    const seq = await latestActivity("task.delete", id);
    const undone = await undo(seq);
    expect(undone.statusCode).toBe(200);

    const restored = await api("GET", `/api/tasks/${id}`);
    expect(restored.statusCode).toBe(200);
    const body = restored.json() as Record<string, unknown>;
    expect(body["status"]).toBe("open");
    expect(body["deleted_at"]).toBeNull();
    expect(body["rev"]).toBe(3);

    const listed = await api("GET", "/api/tasks?view=all");
    expect(listed.statusCode).toBe(200);
    const ids = (
      (listed.json() as { tasks?: Array<{ id: string }> }).tasks ?? []
    ).map((task) => task.id);
    expect(ids).toContain(id);
  });
});

describe("completion undo", () => {
  it("reopens a one-shot completion and allows completing again", async () => {
    const id = newId();
    const dueAt = new Date(Date.now() + 3_600_000).toISOString();
    await api("POST", "/api/tasks", {
      payload: { id, title: "One shot", dueAt },
    });

    const completed = await api("POST", `/api/tasks/${id}/complete`, {
      payload: { occurrenceKey: dueAt },
      headers: { "if-match": '"rev-1"' },
    });
    expect(completed.statusCode).toBe(200);
    expect((completed.json() as { status?: string }).status).toBe("done");
    expect(completionRows(id)).toHaveLength(1);

    const seq = await latestActivity("task.complete", id);
    const undone = await undo(seq);
    expect(undone.statusCode).toBe(200);

    const reopened = await api("GET", `/api/tasks/${id}`);
    expect(reopened.statusCode).toBe(200);
    const openBody = reopened.json() as Record<string, unknown>;
    expect(openBody["status"]).toBe("open");
    expect(openBody["completed_at"]).toBeNull();
    const afterUndo = completionRows(id);
    expect(afterUndo).toHaveLength(1);
    expect(afterUndo[0]?.deleted_at).not.toBeNull();

    const again = await api("POST", `/api/tasks/${id}/complete`, {
      payload: { occurrenceKey: dueAt },
      headers: { "if-match": `"rev-${String(openBody["rev"])}"` },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { status?: string }).status).toBe("done");
    const afterRecomplete = completionRows(id);
    expect(afterRecomplete).toHaveLength(2);
    expect(afterRecomplete.filter((row) => row.deleted_at === null)).toHaveLength(
      1,
    );
  });

  it("restores a recurring series checkpoint and allows completing again", async () => {
    const id = newId();
    const today = new Date().toISOString().slice(0, 10);
    const dueAt = `${today}T09:00:00.000Z`;
    const created = await api("POST", "/api/tasks", {
      payload: {
        id,
        title: "Daily standup undo",
        dueAt,
        rrule: "FREQ=DAILY",
        dtstartLocal: `${today}T09:00:00`,
        timezone: "UTC",
      },
    });
    expect(created.statusCode).toBe(201);
    const before = created.json() as Record<string, unknown>;

    const completed = await api("POST", `/api/tasks/${id}/complete`, {
      payload: {},
      headers: { "if-match": '"rev-1"' },
    });
    expect(completed.statusCode).toBe(200);
    const afterComplete = completed.json() as Record<string, unknown>;
    expect(afterComplete["next_occurrence_at"]).not.toBe(
      before["next_occurrence_at"],
    );

    const seq = await latestActivity("task.complete", id);
    const undone = await undo(seq);
    expect(undone.statusCode).toBe(200);

    const restored = await api("GET", `/api/tasks/${id}`);
    expect(restored.statusCode).toBe(200);
    const body = restored.json() as Record<string, unknown>;
    expect(body["status"]).toBe("open");
    expect(body["next_occurrence_at"]).toBe(before["next_occurrence_at"]);
    expect(body["occurrence_seq"]).toBe(before["occurrence_seq"]);
    expect(
      completionRows(id).filter((row) => row.deleted_at === null),
    ).toHaveLength(0);

    const again = await api("POST", `/api/tasks/${id}/complete`, {
      payload: {},
      headers: { "if-match": `"rev-${String(body["rev"])}"` },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { next_occurrence_at?: string }).next_occurrence_at).toBe(
      afterComplete["next_occurrence_at"],
    );
    expect(
      completionRows(id).filter((row) => row.deleted_at === null),
    ).toHaveLength(1);
  });

  it("undoes a one-shot skip without leaving a completion behind", async () => {
    const id = newId();
    await api("POST", "/api/tasks", {
      payload: { id, title: "Skip then restore" },
    });
    const skipped = await api("POST", `/api/tasks/${id}/skip`, {
      payload: {},
      headers: { "if-match": '"rev-1"' },
    });
    expect(skipped.statusCode).toBe(200);
    expect((skipped.json() as { status?: string }).status).toBe("cancelled");
    expect(completionRows(id)).toHaveLength(1);

    const seq = await latestActivity("task.skip", id);
    const undone = await undo(seq);
    expect(undone.statusCode).toBe(200);

    const restored = await api("GET", `/api/tasks/${id}`);
    expect(restored.statusCode).toBe(200);
    const body = restored.json() as Record<string, unknown>;
    expect(body["status"]).toBe("open");
    expect(
      completionRows(id).filter((row) => row.deleted_at === null),
    ).toHaveLength(0);

    const again = await api("POST", `/api/tasks/${id}/skip`, {
      payload: {},
      headers: { "if-match": `"rev-${String(body["rev"])}"` },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { status?: string }).status).toBe("cancelled");
    expect(
      completionRows(id).filter((row) => row.deleted_at === null),
    ).toHaveLength(1);
  });
});

describe("list membership undo", () => {
  it("share undo removes only the membership; unshare undo restores it", async () => {
    const listId = newId();
    await api("POST", "/api/lists", {
      payload: { id: listId, name: "Shared undo list" },
    });
    await stepUp();

    const shared = await api("POST", `/api/lists/${listId}/share`, {
      payload: { username: "undo-partner" },
    });
    expect(shared.statusCode).toBe(201);
    const memberCount = () =>
      (
        getDb()
          .prepare(
            "SELECT COUNT(*) AS n FROM list_members WHERE list_id = ? AND user_id = ?",
          )
          .get(listId, partnerId) as { n: number }
      ).n;
    expect(memberCount()).toBe(1);

    const shareSeq = await latestActivity("list.share", listId);
    const shareUndo = await undo(shareSeq);
    expect(shareUndo.statusCode).toBe(200);
    expect(memberCount()).toBe(0);
    const liveList = await api("GET", `/api/lists`);
    expect(
      ((liveList.json() as { lists?: Array<{ id: string }> }).lists ?? []).some(
        (list) => list.id === listId,
      ),
    ).toBe(true);

    const sharedAgain = await api("POST", `/api/lists/${listId}/share`, {
      payload: { username: "undo-partner" },
    });
    expect(sharedAgain.statusCode).toBe(201);
    const unshared = await api(
      "DELETE",
      `/api/lists/${listId}/share/${partnerId}`,
    );
    expect(unshared.statusCode).toBe(200);
    expect(memberCount()).toBe(0);

    const unshareSeq = await latestActivity("list.unshare", listId);
    const unshareUndo = await undo(unshareSeq);
    expect(unshareUndo.statusCode).toBe(200);
    expect(memberCount()).toBe(1);
    const membership = getDb()
      .prepare(
        "SELECT role FROM list_members WHERE list_id = ? AND user_id = ?",
      )
      .get(listId, partnerId) as { role: string } | undefined;
    expect(membership?.role).toBe("member");

    const stillLive = getDb()
      .prepare("SELECT deleted_at FROM lists WHERE id = ?")
      .get(listId) as { deleted_at: string | null } | undefined;
    expect(stillLive?.deleted_at).toBeNull();
  });
});

describe("list delete undo", () => {
  it("restores the list and its task memberships", async () => {
    const listId = newId();
    const firstTask = newId();
    const secondTask = newId();
    const otherTask = newId();
    await api("POST", "/api/lists", {
      payload: { id: listId, name: "Home restore" },
    });
    await api("POST", "/api/tasks", {
      payload: { id: firstTask, title: "First member", listId },
    });
    await api("POST", "/api/tasks", {
      payload: { id: secondTask, title: "Second member", listId },
    });
    await api("POST", "/api/tasks", {
      payload: { id: otherTask, title: "Unrelated" },
    });
    // A task created by a shared-list member: the list owner did not create
    // it, but undoing the list delete must still restore its membership.
    const memberTask = newId();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO tasks
           (id, user_id, list_id, title, status, priority, all_day,
            recurrence_mode, clamp_policy, occurrence_seq, missed_count,
            sort_key, rev, created_at, updated_at)
         VALUES (?, ?, ?, 'Member-created task', 'open', 0, 0, 'schedule',
                 'skip', 0, 0, 'V00000000000000', 1, ?, ?)`,
      )
      .run(memberTask, partnerId, listId, now, now);

    const deleted = await api("DELETE", `/api/lists/${listId}`, {
      headers: { "if-match": '"rev-1"' },
    });
    expect(deleted.statusCode).toBe(200);
    for (const taskId of [firstTask, secondTask]) {
      const task = await api("GET", `/api/tasks/${taskId}`);
      expect((task.json() as { list_id?: string | null }).list_id).toBeNull();
    }

    const seq = await latestActivity("list.delete", listId);
    const undone = await undo(seq);
    expect(undone.statusCode).toBe(200);

    const restoredList = getDb()
      .prepare("SELECT deleted_at FROM lists WHERE id = ?")
      .get(listId) as { deleted_at: string | null } | undefined;
    expect(restoredList?.deleted_at).toBeNull();
    const listed = await api("GET", "/api/lists");
    expect(
      ((listed.json() as { lists?: Array<{ id: string }> }).lists ?? []).some(
        (list) => list.id === listId,
      ),
    ).toBe(true);
    for (const taskId of [firstTask, secondTask]) {
      const task = await api("GET", `/api/tasks/${taskId}`);
      expect(task.statusCode).toBe(200);
      expect((task.json() as { list_id?: string | null }).list_id).toBe(listId);
    }
    const memberRestored = getDb()
      .prepare("SELECT list_id FROM tasks WHERE id = ?")
      .get(memberTask) as { list_id: string | null };
    expect(memberRestored.list_id).toBe(listId);
    const unrelated = await api("GET", `/api/tasks/${otherTask}`);
    expect((unrelated.json() as { list_id?: string | null }).list_id).toBeNull();
  });
});

describe("hard purge boundary", () => {
  it("rejects undo of a purge and of an earlier delete after the purge", async () => {
    const id = newId();
    await api("POST", "/api/tasks", {
      payload: { id, title: "Gone forever" },
    });
    const deleted = await api("DELETE", `/api/tasks/${id}`, {
      headers: { "if-match": '"rev-1"' },
    });
    expect(deleted.statusCode).toBe(200);
    const deleteSeq = await latestActivity("task.delete", id);

    await stepUp();
    const purged = await api("DELETE", `/api/trash/tasks/${id}`);
    expect(purged.statusCode).toBe(200);
    expect(
      getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE id = ?").get(id),
    ).toEqual({ n: 0 });

    const purgeSeq = await latestActivity("task.purge", id);
    const purgeUndo = await undo(purgeSeq);
    expect(purgeUndo.statusCode).toBe(409);
    expect((purgeUndo.json() as { code?: string }).code).toBe(
      "purge_not_undoable",
    );

    const deleteUndo = await undo(deleteSeq);
    expect(deleteUndo.statusCode).toBe(409);
    expect((deleteUndo.json() as { code?: string }).code).toBe(
      "purge_not_undoable",
    );
    expect(
      getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE id = ?").get(id),
    ).toEqual({ n: 0 });
  });
});
