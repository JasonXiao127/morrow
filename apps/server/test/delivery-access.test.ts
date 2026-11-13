/**
 * Delivery cancellation on access changes (Round 3).
 *
 * Uses the real Fastify app + a file-backed DB, but a fake push transport:
 * enqueue due reminders for an owner and a shared-list member, remove access
 * through the real unshare/move routes, run the real scheduler, and assert the
 * removed member's endpoint is never called while the owner still receives.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@morrow/db";
import { newId } from "@morrow/shared";
import { resetConfigCache } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { enqueueDueWork, runSchedulerTick } from "../src/scheduler.js";
import type { PushConfig, PushTransport } from "../src/push.js";

const OWNER_PASSWORD = "owner-delivery-password-01";
const MEMBER_PASSWORD = "member-delivery-password-01";
const SETUP_TOKEN = "delivery-setup-token-01";
const NOW = new Date("2026-11-02T12:00:00.000Z");
const OWNER_ENDPOINT = "https://fcm.googleapis.com/fcm/send/owner-device";
const MEMBER_ENDPOINT = "https://fcm.googleapis.com/fcm/send/member-device";

const PUSH_CONFIG: PushConfig = {
  enabled: true,
  publicKey: "BPublicKeyForTestsOnly",
  privateKey: "PrivateKeyForTestsOnly",
  subject: "mailto:test@example.com",
};

let dir = "";
let app: FastifyInstance;
let ownerCookie = "";
let memberCookie = "";
let ownerId = "";
let memberId = "";
let listId = "";
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
  opts: {
    cookie?: string;
    payload?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  return app.inject({
    method: method as "GET",
    url,
    headers: { cookie: opts.cookie ?? ownerCookie, ...(opts.headers ?? {}) },
    payload: opts.payload,
  });
}

function addSubscription(userId: string, id: string, endpoint: string): void {
  const now = NOW.toISOString();
  getDb()
    .prepare(
      `INSERT INTO push_subscriptions
         (id, user_id, endpoint, endpoint_hash, p256dh, auth, enabled,
          fail_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'p256dh-test', 'auth-test', 1, 0, ?, ?)`,
    )
    .run(id, userId, endpoint, `hash-${id}`, now, now);
}

function recordingTransport(): { transport: PushTransport; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      async send(request) {
        calls.push(request.subscription.endpoint);
        return { statusCode: 201 };
      },
    },
  };
}

async function createDueTask(title: string): Promise<string> {
  const res = await api("POST", "/api/tasks", {
    payload: {
      id: newId(),
      title,
      listId,
      dueAt: new Date(NOW.getTime() - 60_000).toISOString(),
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

function deliveryRows(taskId: string): Array<{
  subscription_id: string;
  status: string;
}> {
  return getDb()
    .prepare(
      `SELECT subscription_id, status FROM deliveries
        WHERE task_id = ? ORDER BY subscription_id`,
    )
    .all(taskId) as Array<{ subscription_id: string; status: string }>;
}

beforeAll(async () => {
  for (const key of ["DATABASE_PATH", "SETUP_TOKEN", "APP_URL", "SECRETS_DIR"]) {
    savedEnv[key] = process.env[key];
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-delivery-access-"));
  process.env["DATABASE_PATH"] = path.join(dir, "morrow.db");
  process.env["SETUP_TOKEN"] = SETUP_TOKEN;
  process.env["APP_URL"] = "http://localhost:3000";
  process.env["SECRETS_DIR"] = path.join(dir, "secrets");
  fs.mkdirSync(process.env["SECRETS_DIR"]!, { recursive: true });
  resetConfigCache();
  closeDb();
  app = await buildApp();

  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { token: SETUP_TOKEN, password: OWNER_PASSWORD, timezone: "UTC" },
  });
  expect(setup.statusCode).toBe(201);
  ownerCookie = cookieOf(setup);
  ownerId = (setup.json() as { user: { id: string } }).user.id;

  const stepUp = await api("POST", "/api/auth/password", {
    payload: { password: OWNER_PASSWORD },
  });
  expect(stepUp.statusCode).toBe(200);
  const member = await api("POST", "/api/users", {
    payload: {
      username: "member",
      password: MEMBER_PASSWORD,
      timezone: "UTC",
    },
  });
  expect(member.statusCode).toBe(201);
  memberId = (member.json() as { user: { id: string } }).user.id;
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { username: "member", password: MEMBER_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  memberCookie = cookieOf(login);

  const list = await api("POST", "/api/lists", {
    payload: { id: newId(), name: "Shared delivery list" },
  });
  expect(list.statusCode).toBe(201);
  listId = (list.json() as { id: string }).id;
  const share = await api("POST", `/api/lists/${listId}/share`, {
    payload: { username: "member" },
  });
  expect(share.statusCode).toBe(201);

  addSubscription(
    ownerId,
    "01900000-0000-7000-8000-0000000000a1",
    OWNER_ENDPOINT,
  );
  addSubscription(
    memberId,
    "01900000-0000-7000-8000-0000000000a2",
    MEMBER_ENDPOINT,
  );
});

afterAll(async () => {
  try {
    await app.close();
  } catch {
    // ignore
  }
  closeDb();
  resetConfigCache();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("delivery cancellation on access changes", () => {
  it("does not send after an unshare; the current owner still receives", async () => {
    const taskId = await createDueTask("Unshare delivery task");
    const enqueued = enqueueDueWork(getDb(), { now: NOW });
    expect(enqueued.deliveriesInserted).toBeGreaterThanOrEqual(2);
    expect(deliveryRows(taskId)).toHaveLength(2);

    const stepUp = await api("POST", "/api/auth/password", {
      payload: { password: OWNER_PASSWORD },
    });
    expect(stepUp.statusCode).toBe(200);
    const unshare = await api(
      "DELETE",
      `/api/lists/${listId}/share/${memberId}`,
    );
    expect(unshare.statusCode).toBe(200);

    const after = deliveryRows(taskId);
    const member = after.find(
      (row) => row.subscription_id === "01900000-0000-7000-8000-0000000000a2",
    );
    const owner = after.find(
      (row) => row.subscription_id === "01900000-0000-7000-8000-0000000000a1",
    );
    expect(member?.status).toBe("skipped");
    expect(owner?.status).toBe("pending");

    const { transport, calls } = recordingTransport();
    const tick = await runSchedulerTick(getDb(), {
      now: NOW,
      skipLease: true,
      send: true,
      digests: false,
      pushOptions: { now: NOW, config: PUSH_CONFIG, transport },
    });
    expect(tick.sent).toBeGreaterThanOrEqual(1);
    expect(calls).toContain(OWNER_ENDPOINT);
    expect(calls).not.toContain(MEMBER_ENDPOINT);
  });

  it("does not send after a task moves to a private list", async () => {
    // Re-share so both recipients are eligible again, then enqueue a new task.
    const stepUp = await api("POST", "/api/auth/password", {
      payload: { password: OWNER_PASSWORD },
    });
    expect(stepUp.statusCode).toBe(200);
    const share = await api("POST", `/api/lists/${listId}/share`, {
      payload: { username: "member" },
    });
    expect(share.statusCode).toBe(201);

    const taskId = await createDueTask("Move delivery task");
    enqueueDueWork(getDb(), { now: NOW });
    expect(deliveryRows(taskId)).toHaveLength(2);

    const current = await api("GET", `/api/tasks/${taskId}`);
    expect(current.statusCode).toBe(200);
    const rev = (current.json() as { rev: number }).rev;
    const moved = await api("PATCH", `/api/tasks/${taskId}`, {
      headers: { "if-match": `"rev-${rev}"` },
      payload: { listId: null },
    });
    expect(moved.statusCode).toBe(200);

    const after = deliveryRows(taskId);
    expect(
      after.find(
        (row) => row.subscription_id === "01900000-0000-7000-8000-0000000000a2",
      )?.status,
    ).toBe("skipped");
    expect(
      after.find(
        (row) => row.subscription_id === "01900000-0000-7000-8000-0000000000a1",
      )?.status,
    ).toBe("pending");

    const { transport, calls } = recordingTransport();
    const tick = await runSchedulerTick(getDb(), {
      now: NOW,
      skipLease: true,
      send: true,
      digests: false,
      pushOptions: { now: NOW, config: PUSH_CONFIG, transport },
    });
    expect(tick.sent).toBeGreaterThanOrEqual(1);
    expect(calls).toContain(OWNER_ENDPOINT);
    expect(calls).not.toContain(MEMBER_ENDPOINT);
  });

  it("delivers a member-created shared task to the list owner", async () => {
    // The list is shared again by the previous test. Create the task as the
    // member and assert both the member and the list owner are eligible.
    const created = await api("POST", "/api/tasks", {
      cookie: memberCookie,
      payload: {
        id: newId(),
        title: "Member-created owner delivery",
        listId,
        dueAt: new Date(NOW.getTime() - 60_000).toISOString(),
      },
    });
    expect(created.statusCode).toBe(201);
    const taskId = (created.json() as { id: string }).id;
    enqueueDueWork(getDb(), { now: NOW });
    expect(deliveryRows(taskId)).toHaveLength(2);

    const { transport, calls } = recordingTransport();
    const tick = await runSchedulerTick(getDb(), {
      now: NOW,
      skipLease: true,
      send: true,
      digests: false,
      pushOptions: { now: NOW, config: PUSH_CONFIG, transport },
    });
    expect(tick.sent).toBeGreaterThanOrEqual(2);
    expect(calls).toContain(OWNER_ENDPOINT);
    expect(calls).toContain(MEMBER_ENDPOINT);
  });

  it("does not send after the shared list is deleted", async () => {
    const taskId = await createDueTask("Deleted list delivery task");
    enqueueDueWork(getDb(), { now: NOW });
    expect(deliveryRows(taskId)).toHaveLength(2);

    const current = await api("GET", "/api/lists");
    expect(current.statusCode).toBe(200);
    const rev = (
      (current.json() as { lists: Array<{ id: string; rev: number }> }).lists
        .find((row) => row.id === listId) as { rev: number }
    ).rev;
    const deleted = await api("DELETE", `/api/lists/${listId}`, {
      headers: { "if-match": `"rev-${rev}"` },
    });
    expect(deleted.statusCode).toBe(200);

    const after = deliveryRows(taskId);
    expect(
      after.find(
        (row) => row.subscription_id === "01900000-0000-7000-8000-0000000000a2",
      )?.status,
    ).toBe("skipped");
    expect(
      after.find(
        (row) => row.subscription_id === "01900000-0000-7000-8000-0000000000a1",
      )?.status,
    ).toBe("pending");

    const { transport, calls } = recordingTransport();
    const tick = await runSchedulerTick(getDb(), {
      now: NOW,
      skipLease: true,
      send: true,
      digests: false,
      pushOptions: { now: NOW, config: PUSH_CONFIG, transport },
    });
    expect(tick.sent).toBeGreaterThanOrEqual(1);
    expect(calls).toContain(OWNER_ENDPOINT);
    expect(calls).not.toContain(MEMBER_ENDPOINT);
  });
});
