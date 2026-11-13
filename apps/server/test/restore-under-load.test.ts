/**
 * Restore under load (Round 3): real Fastify app + file-backed SQLite.
 *
 * Proves the maintenance gate, atomic swap, pre-restore snapshot, and consumer
 * rebind together:
 *   - a task written after the export but before the gate is captured by the
 *     pre-restore backup (and not lost to a torn copy);
 *   - a write attempted while maintenance is active gets 503 + Retry-After;
 *   - /readyz reports maintenance, not ready;
 *   - after the swap the scheduler, assistant and MCP are usable on the new DB;
 *   - sessions/capture tokens are invalidated, while the owner can log in and
 *     continue (login_reset_required is advisory).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb, resolveDatabasePath } from "@morrow/db";
import { newId } from "@morrow/shared";
import {
  exportBackup,
  verifyBackupBytes,
  type BackupDb,
} from "../src/backup.js";
import { resetConfigCache } from "../src/config.js";
import { getAssistant } from "../src/assistant.js";
import { buildApp } from "../src/index.js";
import {
  authenticateMcpToken,
  ensureMcpTokenFromEnv,
  getActiveMcpServer,
  startMcpServer,
  stopMcpServer,
} from "../src/mcp.js";
import { restoreDatabaseFromBackup } from "../src/restore.js";
import {
  getActiveScheduler,
  runSchedulerTick,
  startScheduler,
  stopScheduler,
} from "../src/scheduler.js";

const PASSWORD = "restore-under-load-password-01";
const SETUP_TOKEN = "restore-under-load-token-01";
const MCP_TOKEN = "restore-under-load-mcp-token-01";

let dir = "";
let backupDir = "";
let app: FastifyInstance;
let cookie = "";
let ownerId = "";
let captureToken = "";
let baselineTaskId = "";
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
    headers: { cookie: opts.cookie ?? cookie, ...(opts.headers ?? {}) },
    payload: opts.payload,
  });
}

function insertRawTask(title: string): string {
  const id = newId();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO tasks
         (id, user_id, title, status, priority, all_day, recurrence_mode,
          clamp_policy, occurrence_seq, missed_count, sort_key, rev,
          created_at, updated_at)
       VALUES (?, ?, ?, 'open', 0, 0, 'schedule', 'skip', 0, 0, 'V00000000000000', 1, ?, ?)`,
    )
    .run(id, ownerId, title, now, now);
  return id;
}

beforeAll(async () => {
  for (const key of [
    "DATABASE_PATH",
    "SETUP_TOKEN",
    "APP_URL",
    "SECRETS_DIR",
    "BACKUP_DIR",
    "REMINDERS_MCP_TOKEN",
    "MCP_ENABLED",
    "MCP_PORT",
  ]) {
    savedEnv[key] = process.env[key];
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-restore-load-"));
  backupDir = path.join(dir, "backups");
  process.env["DATABASE_PATH"] = path.join(dir, "morrow.db");
  process.env["SETUP_TOKEN"] = SETUP_TOKEN;
  process.env["APP_URL"] = "http://localhost:3000";
  process.env["SECRETS_DIR"] = path.join(dir, "secrets");
  process.env["BACKUP_DIR"] = backupDir;
  process.env["REMINDERS_MCP_TOKEN"] = MCP_TOKEN;
  process.env["MCP_ENABLED"] = "true";
  process.env["MCP_PORT"] = "0";
  fs.mkdirSync(process.env["SECRETS_DIR"]!, { recursive: true });
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
  ownerId = (setup.json() as { user: { id: string } }).user.id;

  const stepUp = await api("POST", "/api/auth/password", {
    payload: { password: PASSWORD },
  });
  expect(stepUp.statusCode).toBe(200);

  const capture = await api("POST", "/api/capture/tokens", {
    payload: { name: "restore invalidation" },
  });
  expect(capture.statusCode).toBe(201);
  captureToken = (capture.json() as { token: string }).token;

  const task = await api("POST", "/api/tasks", {
    payload: {
      id: newId(),
      title: "Baseline task survives restore",
      dueAt: new Date(Date.now() - 120_000).toISOString(),
    },
  });
  expect(task.statusCode).toBe(201);
  baselineTaskId = (task.json() as { id: string }).id;

  // Start both long-lived consumers so restore exercises their rebind paths.
  startScheduler(getDb(), {
    owner: "restore-under-load-scheduler",
    intervalMs: 600_000,
    tickOnStart: false,
    nightlyBackup: false,
  });
  await startMcpServer({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  stopScheduler();
  await stopMcpServer();
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

describe("restore under load", () => {
  it("drains the gate, swaps atomically, and rebinds consumers", async () => {
    const exported = await exportBackup(getDb() as unknown as BackupDb, {
      backupDir,
      exportedAt: new Date().toISOString(),
    });
    expect(exported.bytes.byteLength).toBeGreaterThan(0);

    // A write that lands after the exported snapshot but before the gate. The
    // pre-restore backup must capture it, even though the applying backup
    // intentionally rolls it back.
    const beforeGate = await api("POST", "/api/tasks", {
      payload: { id: newId(), title: "Written before the gate" },
    });
    expect(beforeGate.statusCode).toBe(201);

    const oldScheduler = getActiveScheduler();
    const oldMcp = getActiveMcpServer();
    const oldAssistant = getAssistant();
    const oldStore = oldAssistant.store;

    let blockedStatus = 0;
    let blockedReadStatus = 0;
    let blockedRetryAfter = "";
    let blockedDavStatuses: Record<string, number> = {};
    let readyStatus = 0;
    let readyBody: Record<string, unknown> = {};
    let duringGateTaskId = "";

    const result = await restoreDatabaseFromBackup(
      resolveDatabasePath(),
      exported.bytes,
      {
        backupDir,
        actor: "test",
        onMaintenance: async () => {
          // Literal write during the gate: a direct DB writer bypasses the
          // HTTP gate, so restore's pre-restore snapshot must still capture a
          // consistent state.
          duringGateTaskId = insertRawTask("Written during maintenance");

          const blocked = await api("POST", "/api/tasks", {
            payload: { id: newId(), title: "Must be refused" },
          });
          blockedStatus = blocked.statusCode;
          blockedRetryAfter = String(blocked.headers["retry-after"] ?? "");
          // Reads must not reopen the DB singleton during the file swap.
          blockedReadStatus = (
            await api("GET", "/api/bootstrap")
          ).statusCode;

          // WebDAV writes must be gated too: MKCALENDAR, PROPPATCH and MOVE
          // can mutate the DB and were previously missing from the gate.
          const basic = `Basic ${Buffer.from("owner:any-token").toString("base64")}`;
          const davCases: Array<[string, string]> = [
            ["MKCALENDAR", "/caldav/calendars/new-list/"],
            ["PROPPATCH", "/caldav/calendars/inbox/"],
            ["MOVE", "/caldav/calendars/inbox/anything.ics"],
            ["PUT", "/caldav/calendars/inbox/blocked.ics"],
            ["DELETE", "/caldav/calendars/inbox/blocked.ics"],
          ];
          const statuses: Record<string, number> = {};
          for (const [method, url] of davCases) {
            const res = await app.inject({
              method: method as "GET",
              url,
              headers: {
                authorization: basic,
                destination: "/caldav/calendars/inbox/moved.ics",
              },
              payload: method === "PROPPATCH" ? "<d:propertyupdate/>" : undefined,
            });
            statuses[method] = res.statusCode;
          }
          blockedDavStatuses = statuses;

          const ready = await api("GET", "/readyz");
          readyStatus = ready.statusCode;
          readyBody = ready.json() as Record<string, unknown>;
        },
      },
    );

    expect(blockedStatus).toBe(503);
    expect(blockedReadStatus).toBe(503);
    expect(blockedRetryAfter).toBe("5");
    expect(blockedDavStatuses).toEqual({
      MKCALENDAR: 503,
      PROPPATCH: 503,
      MOVE: 503,
      PUT: 503,
      DELETE: 503,
    });
    expect(readyStatus).toBe(503);
    expect(readyBody["status"]).toBe("maintenance");
    expect(result.maintenance.active).toBe(false);
    expect(result.maintenance.restarted).toEqual(
      expect.arrayContaining(["assistant", "scheduler", "mcp"]),
    );

    // The pre-restore snapshot is the undo button and contains both writes.
    const pre = fs.readFileSync(result.preRestore.path);
    const verified = verifyBackupBytes(pre);
    expect(verified.ok).toBe(true);
    const titles = (verified.document?.data.tasks ?? []).map(
      (row) => row["title"],
    );
    expect(titles).toContain("Written before the gate");
    expect(titles).toContain("Written during maintenance");

    // The applied snapshot rolled the live DB back to the exported baseline.
    const liveTitles = getDb()
      .prepare("SELECT title FROM tasks ORDER BY created_at")
      .all() as Array<{ title: string }>;
    expect(liveTitles.map((row) => row.title)).toContain(
      "Baseline task survives restore",
    );
    expect(liveTitles.map((row) => row.title)).not.toContain(
      "Written before the gate",
    );
    expect(liveTitles.map((row) => row.title)).not.toContain(
      "Written during maintenance",
    );
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE id = ?")
        .get(baselineTaskId) as { n: number },
    ).toEqual({ n: 1 });

    // Sessions and capture tokens are invalid.
    const oldSession = await api("GET", "/api/bootstrap");
    expect(oldSession.statusCode).toBe(401);
    const oldCapture = await app.inject({
      method: "POST",
      url: "/api/capture/quick",
      headers: { authorization: `Bearer ${captureToken}` },
      payload: { text: "must not work after restore" },
    });
    expect(oldCapture.statusCode).toBe(401);

    // Credentials backed out of the restore are not resurrected by MCP boot.
    expect(authenticateMcpToken(getDb(), MCP_TOKEN).ok).toBe(false);

    // The owner can log in again and the scheduler/assistant/MCP run on the new
    // handle.
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "owner", password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    cookie = cookieOf(login);
    const bootstrap = await api("GET", "/api/bootstrap");
    expect(bootstrap.statusCode).toBe(200);
    // Provider routes captured a DB handle at registration; restore must not
    // leave them pointing at the closed pre-swap connection.
    const providers = await api("GET", "/api/providers");
    expect(providers.statusCode).toBe(200);

    const newScheduler = getActiveScheduler();
    expect(newScheduler).not.toBeNull();
    expect(newScheduler).not.toBe(oldScheduler);
    const tick = await runSchedulerTick(getDb(), {
      now: new Date(Date.now() + 1_000),
      skipLease: true,
      send: false,
      digests: false,
    });
    expect(tick.enqueued.deliveriesInserted).toBeGreaterThanOrEqual(1);

    expect(getAssistant().store).not.toBe(oldStore);
    const conversation = await getAssistant().createConversation({
      title: "post-restore conversation",
      createSession: false,
    });
    expect(
      getAssistant()
        .listConversations()
        .some((row) => row.id === conversation.id),
    ).toBe(true);

    const newMcp = getActiveMcpServer();
    expect(newMcp).not.toBeNull();
    expect(newMcp).not.toBe(oldMcp);
    // A fresh token can be bootstrapped into the new DB and authenticates.
    ensureMcpTokenFromEnv(getDb());
    expect(authenticateMcpToken(getDb(), MCP_TOKEN).ok).toBe(true);

    // Operations/proposals are cleared as part of restore invalidation.
    expect(
      getDb().prepare("SELECT COUNT(*) AS n FROM operations").get() as {
        n: number;
      },
    ).toEqual({ n: 0 });
    expect(
      getDb().prepare("SELECT COUNT(*) AS n FROM proposals").get() as {
        n: number;
      },
    ).toEqual({ n: 0 });
  });
});
