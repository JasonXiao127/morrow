/**
 * Delivery ledger (§4/§9): GET /api/tasks/:id/ledger returns real delivery +
 * device state for the task detail one-liner. Covers the empty state and a
 * sent delivery, and proves disabled/deleted subscriptions are not devices.
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
const SETUP_TOKEN = "test-setup-token-ledger-01";

let dir = "";
let app: FastifyInstance;
let cookie = "";
let userId = "";
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

function isoIn(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

function insertSubscription(opts: {
  id?: string;
  enabled?: 0 | 1;
  deletedAt?: string | null;
} = {}): string {
  const id = opts.id ?? newId();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO push_subscriptions
         (id, user_id, endpoint, endpoint_hash, p256dh, auth,
          enabled, fail_count, rev, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, 'p256dh-test', 'auth-test', ?, 0, 1, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      `https://fcm.googleapis.com/fcm/send/${id}`,
      `hash-${id}`,
      opts.enabled ?? 1,
      now,
      now,
      opts.deletedAt ?? null,
    );
  return id;
}

function insertDelivery(opts: {
  taskId: string;
  status: string;
  lastStatus?: string | null;
  sentAt?: string | null;
  createdAt: string;
}): string {
  const id = newId();
  const at = opts.createdAt;
  getDb()
    .prepare(
      `INSERT INTO deliveries
         (id, task_id, occurrence_key, kind, channel, subscription_id,
          status, attempts, last_status, sent_at, rev, created_at, updated_at)
       VALUES (?, ?, ?, 'reminder', 'webpush', '', ?, 1, ?, ?, 1, ?, ?)`,
    )
    .run(
      id,
      opts.taskId,
      at,
      opts.status,
      opts.lastStatus ?? null,
      opts.sentAt ?? null,
      at,
      at,
    );
  return id;
}

beforeAll(async () => {
  for (const k of ["DATABASE_PATH", "SETUP_TOKEN", "APP_URL", "SECRETS_DIR"]) {
    savedEnv[k] = process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "morrow-m3-ledger-"));
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
  userId = ((setup.json() as { user?: { id?: string } }).user?.id ?? "") as string;
  expect(userId).not.toBe("");
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

describe("GET /api/tasks/:id/ledger", () => {
  it("returns the empty ledger before any device or delivery exists", async () => {
    const id = newId();
    const nextAt = isoIn(3_600_000);
    const nextLocal = "2026-11-02T09:00:00";
    const created = await api("POST", "/api/tasks", {
      payload: {
        id,
        title: "No deliveries yet",
        nextOccurrenceAt: nextAt,
        nextOccurrenceLocal: nextLocal,
      },
    });
    expect(created.statusCode).toBe(201);

    const res = await api("GET", `/api/tasks/${id}/ledger`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      next_occurrence_at?: string | null;
      next_occurrence_local?: string | null;
      devices?: number;
      last_sent?: string | null;
      last_status?: string | null;
    };
    expect(body.next_occurrence_at).toBe(nextAt);
    expect(body.next_occurrence_local).toBe(nextLocal);
    expect(body.devices).toBe(0);
    expect(body.last_sent).toBeNull();
    expect(body.last_status).toBeNull();
  });

  it("counts active devices and reports the latest sent delivery", async () => {
    const id = newId();
    const nextAt = isoIn(7_200_000);
    const created = await api("POST", "/api/tasks", {
      payload: {
        id,
        title: "Ledger with delivery",
        nextOccurrenceAt: nextAt,
        nextOccurrenceLocal: "2026-11-03T09:00:00",
      },
    });
    expect(created.statusCode).toBe(201);

    insertSubscription();
    insertSubscription({ enabled: 0 });
    insertSubscription({ deletedAt: new Date().toISOString() });

    insertDelivery({
      taskId: id,
      status: "failed",
      lastStatus: "503",
      createdAt: "2026-11-02T09:00:00.000Z",
    });
    const sentAt = "2026-11-02T10:00:00.000Z";
    insertDelivery({
      taskId: id,
      status: "sent",
      lastStatus: "sent",
      sentAt,
      createdAt: "2026-11-02T10:00:00.000Z",
    });

    const res = await api("GET", `/api/tasks/${id}/ledger`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      next_occurrence_at?: string | null;
      next_occurrence_local?: string | null;
      devices?: number;
      last_sent?: string | null;
      last_status?: string | null;
    };
    expect(body.next_occurrence_at).toBe(nextAt);
    expect(body.devices).toBe(1);
    expect(body.last_sent).toBe(sentAt);
    expect(body.last_status).toBe("sent");
  });

  it("404s for a task the caller does not own", async () => {
    const res = await api("GET", `/api/tasks/${newId()}/ledger`);
    expect(res.statusCode).toBe(404);
  });
});
