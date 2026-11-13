/**
 * Round 2 containment matrix: owner/member roles, global/admin route gates,
 * activity authorization, shared-task tag merge policy, and scoped
 * capture-vs-CalDAV credentials.
 *
 * Each test drives the real Fastify app with two real sessions. UI hiding is
 * not part of the assertion: every gated route must reject the member itself.
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

const OWNER_PASSWORD = "owner-password-owner-password-01";
const MEMBER_PASSWORD = "member-password-member-password-01";
const SETUP_TOKEN = "test-setup-token-authorization-01";

let dir = "";
let app: FastifyInstance;
let ownerCookie = "";
let memberCookie = "";
let ownerId = "";
let memberId = "";
let sharedListId = "";
let ownerSharedTaskId = "";
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

async function stepUpOwner(): Promise<void> {
  const res = await api("POST", "/api/auth/password", {
    payload: { password: OWNER_PASSWORD },
  });
  expect(res.statusCode).toBe(200);
}

async function activitySeq(
  cookie: string,
  action: string,
  entityId: string,
): Promise<number> {
  const res = await api("GET", "/api/activity?cursor=0&limit=500", { cookie });
  expect(res.statusCode).toBe(200);
  const rows =
    (res.json() as {
      activities?: Array<{ seq: number; action: string; entityId: string }>;
    }).activities ?? [];
  const match = rows
    .filter((row) => row.action === action && row.entityId === entityId)
    .sort((a, b) => b.seq - a.seq)[0];
  expect(match).toBeDefined();
  return match!.seq;
}

beforeAll(async () => {
  for (const key of [
    "DATABASE_PATH",
    "SETUP_TOKEN",
    "APP_URL",
    "SECRETS_DIR",
    "BACKUP_DIR",
    "PROVIDER_OVERLAY_PATH",
    "OPENCODE_URL",
    "OPENCODE_PASSWORD",
    "REMINDERS_MCP_TOKEN",
  ]) {
    savedEnv[key] = process.env[key];
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-authz-"));
  process.env["DATABASE_PATH"] = path.join(dir, "morrow.db");
  process.env["SETUP_TOKEN"] = SETUP_TOKEN;
  process.env["APP_URL"] = "http://localhost:3000";
  process.env["SECRETS_DIR"] = path.join(dir, "secrets");
  process.env["BACKUP_DIR"] = path.join(dir, "backups");
  process.env["PROVIDER_OVERLAY_PATH"] = path.join(dir, "providers.json");
  delete process.env["OPENCODE_URL"];
  delete process.env["OPENCODE_PASSWORD"];
  delete process.env["REMINDERS_MCP_TOKEN"];
  fs.mkdirSync(process.env["SECRETS_DIR"]!, { recursive: true });
  resetConfigCache();
  closeDb();
  app = await buildApp();

  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: {
      token: SETUP_TOKEN,
      password: OWNER_PASSWORD,
      timezone: "UTC",
    },
  });
  expect(setup.statusCode).toBe(201);
  ownerCookie = cookieOf(setup);
  ownerId = (setup.json() as { user: { id: string } }).user.id;

  await stepUpOwner();
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
    payload: { id: newId(), name: "Shared authorization list" },
  });
  expect(list.statusCode).toBe(201);
  sharedListId = (list.json() as { id: string }).id;
  const share = await api("POST", `/api/lists/${sharedListId}/share`, {
    payload: { username: "member" },
  });
  expect(share.statusCode).toBe(201);
  const task = await api("POST", "/api/tasks", {
    payload: {
      id: newId(),
      title: "Owner task on shared list",
      listId: sharedListId,
    },
  });
  expect(task.statusCode).toBe(201);
  ownerSharedTaskId = (task.json() as { id: string }).id;
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

describe("owner/member roles", () => {
  it("reports the role in session, bootstrap, and the owner-only user list", async () => {
    const ownerSession = await api("GET", "/api/auth/session");
    expect((ownerSession.json() as { user: { role: string } }).user.role).toBe(
      "owner",
    );
    const memberSession = await api("GET", "/api/auth/session", {
      cookie: memberCookie,
    });
    expect(
      (memberSession.json() as { user: { role: string } }).user.role,
    ).toBe("member");

    const ownerBootstrap = await api("GET", "/api/bootstrap");
    expect(
      (ownerBootstrap.json() as { user: { role: string } }).user.role,
    ).toBe("owner");
    const memberBootstrap = await api("GET", "/api/bootstrap", {
      cookie: memberCookie,
    });
    expect(
      (memberBootstrap.json() as { user: { role: string } }).user.role,
    ).toBe("member");

    const users = await api("GET", "/api/users");
    expect(users.statusCode).toBe(200);
    const rows = (users.json() as { users: Array<{ username: string; role: string }> })
      .users;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ username: "owner", role: "owner" }),
        expect.objectContaining({ username: "member", role: "member" }),
      ]),
    );
  });

  it("hides workspace-global ntfy/digest settings from members", async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const put = db.prepare(
      `INSERT INTO settings (key, value, rev, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, rev = rev + 1`,
    );
    put.run("ntfy", JSON.stringify({ enabled: true, url: "https://ntfy.example", topic: "owner-topic" }), now);
    put.run("digest", JSON.stringify({ morning: { enabled: true, time: "08:00" } }), now);
    put.run("theme", JSON.stringify("dark"), now);

    const ownerSettings = await api("GET", "/api/settings");
    expect(ownerSettings.statusCode).toBe(200);
    const ownerBody = ownerSettings.json() as { settings: Record<string, unknown> };
    expect(ownerBody.settings["ntfy"]).toBeDefined();
    expect(ownerBody.settings["digest"]).toBeDefined();

    const memberSettings = await api("GET", "/api/settings", {
      cookie: memberCookie,
    });
    expect(memberSettings.statusCode).toBe(200);
    const memberBody = memberSettings.json() as { settings: Record<string, unknown> };
    expect(memberBody.settings["ntfy"]).toBeUndefined();
    expect(memberBody.settings["digest"]).toBeUndefined();
    expect(memberBody.settings["theme"]).toBe("dark");

    const memberBootstrap = await api("GET", "/api/bootstrap", {
      cookie: memberCookie,
    });
    const bootstrapSettings = (memberBootstrap.json() as {
      settings: Record<string, unknown>;
    }).settings;
    expect(bootstrapSettings["ntfy"]).toBeUndefined();
    expect(bootstrapSettings["digest"]).toBeUndefined();
  });

  it("keeps member task/list/shared-list/capture functions working", async () => {
    const ownList = await api("POST", "/api/lists", {
      cookie: memberCookie,
      payload: { id: newId(), name: "Member private list" },
    });
    expect(ownList.statusCode).toBe(201);
    const ownListId = (ownList.json() as { id: string }).id;

    const ownTask = await api("POST", "/api/tasks", {
      cookie: memberCookie,
      payload: { id: newId(), title: "Member private task", listId: ownListId },
    });
    expect(ownTask.statusCode).toBe(201);

    const sharedTask = await api("POST", "/api/tasks", {
      cookie: memberCookie,
      payload: {
        id: newId(),
        title: "Member task on shared list",
        listId: sharedListId,
      },
    });
    expect(sharedTask.statusCode).toBe(201);

    const sharedLists = await api("GET", "/api/lists", {
      cookie: memberCookie,
    });
    expect(
      (sharedLists.json() as { lists: Array<{ id: string; shared: number }> }).lists,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sharedListId, shared: 1 }),
      ]),
    );
  });
});

describe("password change revokes persistent tokens", () => {
  it("invalidates capture/CalDAV tokens when the account password changes", async () => {
    const stepUp = await api("POST", "/api/auth/password", {
      payload: { password: OWNER_PASSWORD },
    });
    expect(stepUp.statusCode).toBe(200);
    const username = "token-reset-user";
    const password = "token-reset-password-01";
    const created = await api("POST", "/api/users", {
      payload: { username, password, timezone: "UTC" },
    });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username, password },
    });
    expect(login.statusCode).toBe(200);
    const userCookie = cookieOf(login);
    const tokenRes = await api("POST", "/api/capture/tokens", {
      cookie: userCookie,
      payload: { name: "Token to revoke", kind: "caldav" },
    });
    expect(tokenRes.statusCode).toBe(201);
    const token = (tokenRes.json() as { token: string }).token;
    const before = await app.inject({
      method: "PROPFIND",
      url: "/caldav/calendars/",
      headers: {
        authorization: `Basic ${Buffer.from(`owner:${token}`).toString("base64")}`,
        depth: "0",
      },
    });
    expect(before.statusCode).toBe(207);

    const changed = await api("POST", "/api/auth/change-password", {
      cookie: userCookie,
      payload: {
        currentPassword: password,
        newPassword: "token-reset-password-02",
      },
    });
    expect(changed.statusCode).toBe(200);
    const after = await app.inject({
      method: "PROPFIND",
      url: "/caldav/calendars/",
      headers: {
        authorization: `Basic ${Buffer.from(`owner:${token}`).toString("base64")}`,
        depth: "0",
      },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("capture token ids", () => {
  it("returns a typed 409 for a duplicate client-chosen id", async () => {
    const id = newId();
    const first = await api("POST", "/api/capture/tokens", {
      payload: { id, name: "Owner token" },
    });
    expect(first.statusCode).toBe(201);
    const duplicate = await api("POST", "/api/capture/tokens", {
      cookie: memberCookie,
      payload: { id, name: "Member duplicate" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.json() as { code?: string }).code).toBe("token_exists");
  });
});

describe("shared list ownership", () => {
  it("lets the list owner read a task created by a member", async () => {
    const list = await api("POST", "/api/lists", {
      payload: { id: newId(), name: "Owner visibility" },
    });
    expect(list.statusCode).toBe(201);
    const listId = (list.json() as { id: string }).id;
    expect(
      (
        await api("POST", `/api/lists/${listId}/share`, {
          payload: { username: "member" },
        })
      ).statusCode,
    ).toBe(201);

    const created = await api("POST", "/api/tasks", {
      cookie: memberCookie,
      payload: {
        id: newId(),
        title: "Created by the member",
        listId,
      },
    });
    expect(created.statusCode).toBe(201);
    const taskId = (created.json() as { id: string }).id;

    const ownerRead = await api("GET", `/api/tasks/${taskId}`);
    expect(ownerRead.statusCode).toBe(200);
    expect((ownerRead.json() as { title: string }).title).toBe(
      "Created by the member",
    );
    const ownerTasks = await api("GET", `/api/tasks?listId=${listId}`);
    expect(ownerTasks.statusCode).toBe(200);
    expect(
      (
        ownerTasks.json() as { tasks?: Array<{ id: string }> }
      ).tasks?.some((task) => task.id === taskId),
    ).toBe(true);

    const memberRead = await api("GET", `/api/tasks/${taskId}`, {
      cookie: memberCookie,
    });
    expect(memberRead.statusCode).toBe(200);

    const ownerTask = await api("POST", "/api/tasks", {
      payload: { id: newId(), title: "Owner task in shared list", listId },
    });
    expect(ownerTask.statusCode).toBe(201);
    const ownerTaskId = (ownerTask.json() as { id: string }).id;
    const memberList = await api("POST", "/api/lists", {
      cookie: memberCookie,
      payload: { id: newId(), name: "Member-only list" },
    });
    expect(memberList.statusCode).toBe(201);
    const memberListId = (memberList.json() as { id: string }).id;
    const move = await api("PATCH", `/api/tasks/${ownerTaskId}`, {
      cookie: memberCookie,
      payload: { listId: memberListId },
      headers: { "if-match": '"rev-1"' },
    });
    expect(move.statusCode).toBe(403);
    expect((move.json() as { code?: string }).code).toBe("creator_only");
    const stillThere = await api("GET", `/api/tasks/${ownerTaskId}`, {
      cookie: memberCookie,
    });
    expect((stillThere.json() as { list_id?: string }).list_id).toBe(listId);

    // A shared list id is visible to the member; reusing it must not crash
    // the primary-key insert.
    const duplicate = await api("POST", "/api/lists", {
      cookie: memberCookie,
      payload: { id: listId, name: "Member copy" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.json() as { code?: string }).code).toBe("list_exists");
  });
});

describe("global/admin route gates", () => {
  const memberDenied: Array<[string, string, unknown?]> = [
    ["GET", "/api/backup/export"],
    ["POST", "/api/backup/run"],
    ["GET", "/api/backup/runs"],
    ["GET", "/api/backup/download/not-a-run"],
    ["POST", "/api/backup/import"],
    ["PATCH", "/api/settings", { theme: "dark" }],
    ["GET", "/api/users"],
    ["GET", "/api/diagnostics"],
    [
      "POST",
      "/api/users",
      { username: "sneaky", password: "long-enough-password", timezone: "UTC" },
    ],
    ["GET", "/api/providers"],
    ["POST", "/api/providers", { kind: "custom" }],
    ["PATCH", "/api/providers/x/rotate", { key: "sk-test" }],
    ["DELETE", "/api/providers/x"],
    ["POST", "/api/providers/x/test"],
    ["POST", "/api/providers/x/discover-models"],
    ["GET", "/api/mcp/status"],
    ["PATCH", "/api/mcp", { enabled: false }],
    ["POST", "/api/mcp/tokens/rotate"],
    ["DELETE", "/api/mcp/tokens/x"],
    ["GET", "/api/assistant/status"],
    ["GET", "/api/model"],
    ["POST", "/api/assistant/settings", { aiEnabled: false }],
    ["POST", "/api/assistant/conversations", {}],
    ["GET", "/api/assistant/conversations"],
    ["GET", "/api/assistant/conversations/x/messages"],
    ["POST", "/api/assistant/conversations/x/messages", { text: "hello" }],
    ["POST", "/api/assistant/conversations/x/stop"],
    ["GET", "/api/assistant/conversations/x/stream"],
    ["POST", "/api/assistant/plan-my-day", { timezone: "UTC" }],
    ["POST", "/api/assistant/undo", { batchId: "x" }],
    ["GET", "/api/proposals"],
    ["GET", "/api/proposals/x"],
    ["POST", "/api/proposals/x/apply", {}],
    ["POST", "/api/proposals/x/dismiss"],
    ["POST", "/api/proposals/x/undo"],
    ["POST", "/api/ntfy/test"],
  ];

  it("rejects every member call with 403 owner_only and no payload data", async () => {
    for (const [method, url, payload] of memberDenied) {
      const res = await api(method, url, { cookie: memberCookie, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      const body = res.json() as Record<string, unknown>;
      expect(body["code"], `${method} ${url}`).toBe("owner_only");
      expect(body["status"], `${method} ${url}`).toBe(403);
      expect(body["users"], `${method} ${url}`).toBeUndefined();
      expect(body["settings"], `${method} ${url}`).toBeUndefined();
      expect(body["providers"], `${method} ${url}`).toBeUndefined();
      expect(body["runs"], `${method} ${url}`).toBeUndefined();
      expect(body["proposals"], `${method} ${url}`).toBeUndefined();
      expect(body["conversations"], `${method} ${url}`).toBeUndefined();
    }
  });

  it("keeps deterministic capture available to members but gates capture AI", async () => {
    const deterministic = await api("POST", "/api/capture/parse", {
      cookie: memberCookie,
      payload: { text: "Member capture tomorrow at 9" },
    });
    expect(deterministic.statusCode).toBe(200);

    const ai = await api("POST", "/api/capture/parse", {
      cookie: memberCookie,
      payload: { text: "Member capture tomorrow at 9", ai: true },
    });
    expect(ai.statusCode).toBe(403);
    expect((ai.json() as { code: string }).code).toBe("owner_only");
  });

  it("lets the owner reach each gated surface", async () => {
    await stepUpOwner();

    const settings = await api("PATCH", "/api/settings", {
      payload: { theme: "dark" },
    });
    expect(settings.statusCode).toBe(200);

    const users = await api("GET", "/api/users");
    expect(users.statusCode).toBe(200);
    const extraUser = await api("POST", "/api/users", {
      payload: {
        username: "member2",
        password: MEMBER_PASSWORD,
        timezone: "UTC",
      },
    });
    expect(extraUser.statusCode).toBe(201);

    const exported = await api("GET", "/api/backup/export");
    expect(exported.statusCode).toBe(200);
    const runs = await api("GET", "/api/backup/runs");
    expect(runs.statusCode).toBe(200);
    const run = await api("POST", "/api/backup/run");
    expect(run.statusCode).toBe(200);
    const runId = (run.json() as { run: { id: string } }).run.id;
    const download = await api("GET", `/api/backup/download/${runId}`);
    expect(download.statusCode).toBe(200);

    const boundary = "----morrow-authz-import";
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="backup"; filename="backup.json"\r\nContent-Type: application/json\r\n\r\n`,
      ),
      Buffer.from(exported.body, "utf8"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const imported = await app.inject({
      method: "POST",
      url: "/api/backup/import?dryRun=1",
      headers: {
        cookie: ownerCookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipart,
    });
    expect(imported.statusCode).toBe(200);
    expect((imported.json() as { dryRun: boolean }).dryRun).toBe(true);

    const provider = await api("POST", "/api/providers", {
      payload: {
        kind: "custom",
        providerId: "authz-acme",
        baseUrl: "https://api.example.com/v1",
        key: "sk-live-authz-1234567890",
      },
    });
    expect(provider.statusCode).toBe(201);
    const providerId = (provider.json() as { provider: { id: string } }).provider
      .id;
    const providerList = await api("GET", "/api/providers");
    expect(providerList.statusCode).toBe(200);
    const rotated = await api("PATCH", `/api/providers/${providerId}/rotate`, {
      payload: { key: "sk-live-authz-0987654321" },
    });
    expect(rotated.statusCode).toBe(200);
    const tested = await api("POST", `/api/providers/${providerId}/test`);
    expect(tested.statusCode).toBe(200);
    const discovered = await api(
      "POST",
      `/api/providers/${providerId}/discover-models`,
    );
    expect(discovered.statusCode).toBe(200);
    const removed = await api("DELETE", `/api/providers/${providerId}`);
    expect(removed.statusCode).toBe(200);

    const mcpStatus = await api("GET", "/api/mcp/status");
    expect(mcpStatus.statusCode).toBe(200);
    const mcpToggle = await api("PATCH", "/api/mcp", {
      payload: { enabled: true },
    });
    expect(mcpToggle.statusCode).toBe(200);
    const rotatedMcp = await api("POST", "/api/mcp/tokens/rotate");
    expect(rotatedMcp.statusCode).toBe(200);
    const tokenId = (rotatedMcp.json() as { tokenId: string }).tokenId;
    const revokedMcp = await api("DELETE", `/api/mcp/tokens/${tokenId}`);
    expect(revokedMcp.statusCode).toBe(200);

    const assistantStatus = await api("GET", "/api/assistant/status");
    expect(assistantStatus.statusCode).toBe(200);
    const models = await api("GET", "/api/model");
    expect(models.statusCode).toBe(200);
    const assistantSettings = await api("POST", "/api/assistant/settings", {
      payload: { aiEnabled: false },
    });
    expect(assistantSettings.statusCode).toBe(200);

    const conversation = await api("POST", "/api/assistant/conversations", {
      payload: { title: "Authz" },
    });
    expect(conversation.statusCode).toBe(201);
    const conversationId = (
      conversation.json() as { conversation: { id: string } }
    ).conversation.id;
    const conversationList = await api("GET", "/api/assistant/conversations");
    expect(conversationList.statusCode).toBe(200);
    const messages = await api(
      "GET",
      `/api/assistant/conversations/${conversationId}/messages`,
    );
    expect(messages.statusCode).toBe(200);
    const prompt = await api(
      "POST",
      `/api/assistant/conversations/${conversationId}/messages`,
      { payload: { text: "Owner prompt with assistant off" } },
    );
    // Owner passed the gate; AI-off returns the honest 503 instead of 403.
    expect(prompt.statusCode).toBe(503);
    expect((prompt.json() as { code: string }).code).toBe(
      "agent_not_configured",
    );
    const captureAi = await api("POST", "/api/capture/parse", {
      payload: { text: "Owner capture tomorrow", ai: true },
    });
    expect(captureAi.statusCode).toBe(503);
    expect((captureAi.json() as { code: string }).code).toBe("ai_unavailable");
    const stopped = await api(
      "POST",
      `/api/assistant/conversations/${conversationId}/stop`,
    );
    expect(stopped.statusCode).toBe(200);
    const missingStream = await api(
      "GET",
      "/api/assistant/conversations/not-a-conversation/stream",
    );
    expect(missingStream.statusCode).toBe(404);

    const unscheduled = await api("POST", "/api/tasks", {
      payload: { id: newId(), title: "Authz plan task" },
    });
    expect(unscheduled.statusCode).toBe(201);
    const plan = await api("POST", "/api/assistant/plan-my-day", {
      payload: { timezone: "UTC" },
    });
    expect(plan.statusCode).toBe(200);
    const proposal = (
      plan.json() as {
        proposal: {
          id: string;
          baseRev: number;
          payloadHash: string;
          operations: unknown[];
        } | null;
      }
    ).proposal;
    expect(proposal).not.toBeNull();

    const proposalList = await api("GET", "/api/proposals?status=all");
    expect(proposalList.statusCode).toBe(200);
    const proposalDetail = await api(
      "GET",
      `/api/proposals/${proposal!.id}`,
    );
    expect(proposalDetail.statusCode).toBe(200);
    const applied = await api(
      "POST",
      `/api/proposals/${proposal!.id}/apply`,
      {
        payload: {
          baseRev: proposal!.baseRev,
          payloadHash: proposal!.payloadHash,
        },
      },
    );
    expect(applied.statusCode).toBe(200);
    const batchId = (applied.json() as { batchId: string }).batchId;
    const assistantUndo = await api("POST", "/api/assistant/undo", {
      payload: { batchId },
    });
    expect(assistantUndo.statusCode).toBe(200);

    const dismissTask = await api("POST", "/api/tasks", {
      payload: { id: newId(), title: "Authz dismiss task" },
    });
    expect(dismissTask.statusCode).toBe(201);
    const dismissPlan = await api("POST", "/api/assistant/plan-my-day", {
      payload: { timezone: "UTC" },
    });
    const dismissProposal = (
      dismissPlan.json() as { proposal: { id: string } | null }
    ).proposal;
    expect(dismissProposal).not.toBeNull();
    const dismissed = await api(
      "POST",
      `/api/proposals/${dismissProposal!.id}/dismiss`,
    );
    expect(dismissed.statusCode).toBe(200);

    const undoTask = await api("POST", "/api/tasks", {
      payload: { id: newId(), title: "Authz undo task" },
    });
    expect(undoTask.statusCode).toBe(201);
    const undoPlan = await api("POST", "/api/assistant/plan-my-day", {
      payload: { timezone: "UTC" },
    });
    const undoProposal = (
      undoPlan.json() as {
        proposal: {
          id: string;
          baseRev: number;
          payloadHash: string;
        } | null;
      }
    ).proposal;
    expect(undoProposal).not.toBeNull();
    const appliedAgain = await api(
      "POST",
      `/api/proposals/${undoProposal!.id}/apply`,
      {
        payload: {
          baseRev: undoProposal!.baseRev,
          payloadHash: undoProposal!.payloadHash,
        },
      },
    );
    expect(appliedAgain.statusCode).toBe(200);
    const undoneProposal = await api(
      "POST",
      `/api/proposals/${undoProposal!.id}/undo`,
    );
    expect(undoneProposal.statusCode).toBe(200);

    const ntfy = await api("POST", "/api/ntfy/test");
    expect(ntfy.statusCode).not.toBe(403);
    expect([200, 503]).toContain(ntfy.statusCode);
  });
});

describe("activity authorization", () => {
  it("filters member lists to their own rows and blocks direct-seq owner undo", async () => {
    const ownerTask = await api("POST", "/api/tasks", {
      payload: { id: newId(), title: "Owner private activity task" },
    });
    expect(ownerTask.statusCode).toBe(201);
    const ownerTaskId = (ownerTask.json() as { id: string }).id;
    const updated = await api("PATCH", `/api/tasks/${ownerTaskId}`, {
      headers: { "if-match": '"rev-1"' },
      payload: { title: "Owner private activity task v2" },
    });
    expect(updated.statusCode).toBe(200);
    const ownerSeq = await activitySeq(ownerCookie, "task.update", ownerTaskId);

    const memberList = await api("GET", "/api/activity?cursor=0&limit=500", {
      cookie: memberCookie,
    });
    expect(memberList.statusCode).toBe(200);
    const memberRows = (
      memberList.json() as {
        activities: Array<{ seq: number; actorId: string | null }>;
      }
    ).activities;
    expect(memberRows.some((row) => row.seq === ownerSeq)).toBe(false);
    expect(memberRows.every((row) => row.actorId === memberId)).toBe(true);

    const denied = await api("POST", `/api/activity/${ownerSeq}/undo`, {
      cookie: memberCookie,
    });
    expect(denied.statusCode).toBe(404);
    const current = await api("GET", `/api/tasks/${ownerTaskId}`);
    expect((current.json() as { title: string }).title).toBe(
      "Owner private activity task v2",
    );

    const memberTask = await api("POST", "/api/tasks", {
      cookie: memberCookie,
      payload: { id: newId(), title: "Member activity task" },
    });
    const memberTaskId = (memberTask.json() as { id: string }).id;
    const memberUpdate = await api("PATCH", `/api/tasks/${memberTaskId}`, {
      cookie: memberCookie,
      headers: { "if-match": '"rev-1"' },
      payload: { title: "Member activity task v2" },
    });
    expect(memberUpdate.statusCode).toBe(200);
    const memberSeq = await activitySeq(
      memberCookie,
      "task.update",
      memberTaskId,
    );
    const ownUndo = await api("POST", `/api/activity/${memberSeq}/undo`, {
      cookie: memberCookie,
    });
    expect(ownUndo.statusCode).toBe(200);
    const restored = await api("GET", `/api/tasks/${memberTaskId}`, {
      cookie: memberCookie,
    });
    expect((restored.json() as { title: string }).title).toBe(
      "Member activity task",
    );

    const deleteTask = await api("POST", "/api/tasks", {
      cookie: memberCookie,
      payload: { id: newId(), title: "Member delete activity task" },
    });
    const deleteTaskId = (deleteTask.json() as { id: string }).id;
    const deleted = await api("DELETE", `/api/tasks/${deleteTaskId}`, {
      cookie: memberCookie,
      headers: { "if-match": '"rev-1"' },
    });
    expect(deleted.statusCode).toBe(200);
    const deleteSeq = await activitySeq(
      memberCookie,
      "task.delete",
      deleteTaskId,
    );
    const undoDelete = await api("POST", `/api/activity/${deleteSeq}/undo`, {
      cookie: memberCookie,
    });
    expect(undoDelete.statusCode).toBe(200);
    const restoredDelete = await api("GET", `/api/tasks/${deleteTaskId}`, {
      cookie: memberCookie,
    });
    expect(restoredDelete.statusCode).toBe(200);
  });

  it("blocks a member from undoing an owner action on a shared list", async () => {
    // The owner-gated-surface test above runs plan-my-day apply/undo, which
    // bumps this task's revision. Read the current ETag instead of assuming
    // the creation revision so this assertion stays order-independent.
    const current = await api("GET", `/api/tasks/${ownerSharedTaskId}`);
    expect(current.statusCode).toBe(200);
    const etag = String(current.headers["etag"]);
    expect(etag).toMatch(/^"rev-\d+"$/);
    const updated = await api("PATCH", `/api/tasks/${ownerSharedTaskId}`, {
      headers: { "if-match": etag },
      payload: { title: "Owner shared task v2" },
    });
    expect(updated.statusCode).toBe(200);
    const ownerSeq = await activitySeq(
      ownerCookie,
      "task.update",
      ownerSharedTaskId,
    );
    const denied = await api("POST", `/api/activity/${ownerSeq}/undo`, {
      cookie: memberCookie,
    });
    expect(denied.statusCode).toBe(404);

    const ownerView = await api("GET", "/api/activity?cursor=0&limit=500");
    expect(ownerView.statusCode).toBe(200);
    expect(
      (
        ownerView.json() as {
          activities: Array<{ seq: number; actorId: string | null }>;
        }
      ).activities.some((row) => row.seq === ownerSeq),
    ).toBe(true);
  });
});

describe("shared-task tag merge policy", () => {
  it("preserves the owner's tag when a member edits tags", async () => {
    const ownerTag = await api("POST", "/api/tags", {
      payload: { name: "Owner tag" },
    });
    expect(ownerTag.statusCode).toBe(201);
    const ownerTagId = (ownerTag.json() as { id: string }).id;
    const ownerAttach = await api("PUT", `/api/tasks/${ownerSharedTaskId}/tags`, {
      payload: { tagIds: [ownerTagId] },
    });
    expect(ownerAttach.statusCode).toBe(200);

    const memberTag = await api("POST", "/api/tags", {
      cookie: memberCookie,
      payload: { name: "Member tag" },
    });
    expect(memberTag.statusCode).toBe(201);
    const memberTagId = (memberTag.json() as { id: string }).id;

    const memberAttach = await api(
      "PUT",
      `/api/tasks/${ownerSharedTaskId}/tags`,
      { cookie: memberCookie, payload: { tagIds: [memberTagId] } },
    );
    expect(memberAttach.statusCode).toBe(200);
    expect(
      (memberAttach.json() as { tags: Array<{ id: string }> }).tags.map(
        (tag) => tag.id,
      ),
    ).toEqual([memberTagId]);

    const links = getDb()
      .prepare(
        "SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY tag_id ASC",
      )
      .all(ownerSharedTaskId) as Array<{ tag_id: string }>;
    expect(links.map((row) => row.tag_id)).toEqual(
      [ownerTagId, memberTagId].sort(),
    );

    const ownerView = await api("GET", `/api/tasks/${ownerSharedTaskId}/tags`);
    expect(
      (ownerView.json() as { tags: Array<{ id: string }> }).tags.map(
        (tag) => tag.id,
      ),
    ).toEqual([ownerTagId]);

    const cannotUseOwnerTag = await api(
      "PUT",
      `/api/tasks/${ownerSharedTaskId}/tags`,
      { cookie: memberCookie, payload: { tagIds: [ownerTagId] } },
    );
    expect(cannotUseOwnerTag.statusCode).toBe(400);
    expect((cannotUseOwnerTag.json() as { code: string }).code).toBe(
      "unknown_tag",
    );

    const memberClear = await api(
      "PUT",
      `/api/tasks/${ownerSharedTaskId}/tags`,
      { cookie: memberCookie, payload: { tagIds: [] } },
    );
    expect(memberClear.statusCode).toBe(200);
    const remaining = getDb()
      .prepare("SELECT tag_id FROM task_tags WHERE task_id = ?")
      .all(ownerSharedTaskId) as Array<{ tag_id: string }>;
    expect(remaining.map((row) => row.tag_id)).toEqual([ownerTagId]);
  });
});

describe("capture vs CalDAV credentials", () => {
  it("keeps the two token purposes separate", async () => {
    const capture = await api("POST", "/api/capture/tokens", {
      cookie: memberCookie,
      payload: { name: "Member capture" },
    });
    expect(capture.statusCode).toBe(201);
    const captureBody = capture.json() as { token: string; kind: string };
    expect(captureBody.kind).toBe("capture");

    const quick = await app.inject({
      method: "POST",
      url: "/api/capture/quick",
      headers: { authorization: `Bearer ${captureBody.token}` },
      payload: { text: "Member shortcut task" },
    });
    expect(quick.statusCode).toBe(201);

    const caldav = await api("POST", "/api/capture/tokens", {
      cookie: memberCookie,
      payload: { name: "Member CalDAV", kind: "caldav" },
    });
    expect(caldav.statusCode).toBe(201);
    const caldavBody = caldav.json() as { token: string; kind: string };
    expect(caldavBody.kind).toBe("caldav");

    const captureFeed = await app.inject({
      method: "GET",
      url: `/api/calendar.ics?token=${encodeURIComponent(captureBody.token)}`,
    });
    expect(captureFeed.statusCode).toBe(401);

    const caldavFeed = await app.inject({
      method: "GET",
      url: `/api/calendar.ics?token=${encodeURIComponent(caldavBody.token)}`,
    });
    expect(caldavFeed.statusCode).toBe(200);

    const caldavQuick = await app.inject({
      method: "POST",
      url: "/api/capture/quick",
      headers: { authorization: `Bearer ${caldavBody.token}` },
      payload: { text: "Must not be captured" },
    });
    expect(caldavQuick.statusCode).toBe(401);

    const caldavEmail = await app.inject({
      method: "POST",
      url: `/api/inbound/email?token=${encodeURIComponent(caldavBody.token)}`,
      payload: { subject: "Must not be captured" },
    });
    expect(caldavEmail.statusCode).toBe(401);

    const caldavId = newId();
    const capturePut = await app.inject({
      method: "PUT",
      url: `/caldav/calendars/inbox/${caldavId}.ics`,
      headers: {
        authorization: `Basic ${Buffer.from(`owner:${captureBody.token}`).toString("base64")}`,
        "content-type": "text/calendar",
      },
      payload: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
    });
    expect(capturePut.statusCode).toBe(401);

    const caldavPut = await app.inject({
      method: "PUT",
      url: `/caldav/calendars/inbox/${caldavId}.ics`,
      headers: {
        authorization: `Basic ${Buffer.from(`owner:${caldavBody.token}`).toString("base64")}`,
        "content-type": "text/calendar",
      },
      payload: [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VTODO",
        `UID:${caldavId}@morrow`,
        "SUMMARY:Member CalDAV task",
        "DUE:20261110T090000Z",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n"),
    });
    expect([201, 204]).toContain(caldavPut.statusCode);

    const created = await api("GET", `/api/tasks/${caldavId}`, {
      cookie: memberCookie,
    });
    expect(created.statusCode).toBe(200);
    expect((created.json() as { title: string }).title).toBe(
      "Member CalDAV task",
    );
  });
});

describe("per-account timezone", () => {
  it("lets a member update their own timezone without owner rights", async () => {
    const updated = await api("PATCH", "/api/me", {
      cookie: memberCookie,
      payload: { timezone: "Pacific/Auckland" },
    });
    expect(updated.statusCode).toBe(200);
    expect(
      (updated.json() as { user: { timezone: string } }).user.timezone,
    ).toBe("Pacific/Auckland");

    const bootstrap = await api("GET", "/api/bootstrap", {
      cookie: memberCookie,
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(
      (bootstrap.json() as { user: { timezone: string } }).user.timezone,
    ).toBe("Pacific/Auckland");

    const invalid = await api("PATCH", "/api/me", {
      cookie: memberCookie,
      payload: { timezone: "Mars/Olympus" },
    });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { code?: string }).code).toBe("invalid_timezone");

    const anonymous = await app.inject({
      method: "PATCH",
      url: "/api/me",
      payload: { timezone: "UTC" },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe("startup role backfill", () => {
  it("promotes the earliest user when no owner row exists", async () => {
    const { ensureOwnerRole } = await import("../src/auth.js");
    getDb().prepare("UPDATE users SET role = 'member'").run();
    ensureOwnerRole();
    const rows = getDb()
      .prepare("SELECT id, role FROM users ORDER BY created_at ASC, id ASC")
      .all() as Array<{ id: string; role: string }>;
    expect(rows.filter((row) => row.role === "owner")).toHaveLength(1);
    expect(rows[0]?.id).toBe(ownerId);
  });

  it("ignores a soft-deleted owner and promotes a live account", async () => {
    const { ensureOwnerRole } = await import("../src/auth.js");
    const now = new Date().toISOString();
    getDb()
      .prepare(
        "UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, now, ownerId);
    ensureOwnerRole();
    const liveOwners = getDb()
      .prepare(
        "SELECT id FROM users WHERE role = 'owner' AND deleted_at IS NULL",
      )
      .all() as Array<{ id: string }>;
    expect(liveOwners).toHaveLength(1);
    expect(liveOwners[0]?.id).not.toBe(ownerId);
    // Restore state for any later suite.
    getDb()
      .prepare(
        "UPDATE users SET deleted_at = NULL, role = 'owner' WHERE id = ?",
      )
      .run(ownerId);
    getDb()
      .prepare(
        "UPDATE users SET role = 'member' WHERE id != ? AND role = 'owner'",
      )
      .run(ownerId);
  });
});
