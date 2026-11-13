/**
 * v0.2 product surfaces: tags, subtasks, capture tokens, list sharing, and
 * CalDAV. These tests exercise the new routes through the real Fastify app.
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

const PASSWORD = "correct-horse-battery-staple-v2";
const PARTNER_PASSWORD = "another-long-password-v2";
const SETUP_TOKEN = "test-setup-token-product-01";

let dir = "";
let app: FastifyInstance;
let cookie = "";
let taskId = "";
let listId = "";
let tagId = "";
let captureToken = "";
let caldavToken = "";
const savedEnv: Record<string, string | undefined> = {};

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first).split(";")[0] as string;
}

async function api(
  method: string,
  url: string,
  opts: {
    payload?: unknown;
    headers?: Record<string, string>;
    sessionCookie?: string;
  } = {},
) {
  return app.inject({
    method: method as "GET",
    url,
    headers: {
      cookie: opts.sessionCookie ?? cookie,
      ...(opts.headers ?? {}),
    },
    payload: opts.payload,
  });
}

beforeAll(async () => {
  for (const k of ["DATABASE_PATH", "SETUP_TOKEN", "APP_URL", "SECRETS_DIR"]) {
    savedEnv[k] = process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "morrow-product-"));
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

  const list = await api("POST", "/api/lists", {
    payload: { id: newId(), name: "Shared" },
  });
  expect(list.statusCode).toBe(201);
  listId = (list.json() as { id: string }).id;
  const task = await api("POST", "/api/tasks", {
    payload: { id: newId(), title: "Product task", listId },
  });
  expect(task.statusCode).toBe(201);
  taskId = (task.json() as { id: string }).id;
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

describe("tags and subtasks", () => {
  it("creates a tag and attaches it to a task", async () => {
    const created = await api("POST", "/api/tags", {
      payload: { name: "Work" },
    });
    expect(created.statusCode).toBe(201);
    tagId = (created.json() as { id: string }).id;

    const attached = await api("PUT", `/api/tasks/${taskId}/tags`, {
      payload: { tagIds: [tagId] },
    });
    expect(attached.statusCode).toBe(200);
    expect(
      (attached.json() as { tags: Array<{ name: string }> }).tags[0]?.name,
    ).toBe("Work");

    const bootstrap = await api("GET", "/api/bootstrap");
    const body = bootstrap.json() as {
      tags: Array<{ id: string }>;
      taskTags: Array<{ task_id: string; tag_id: string }>;
    };
    expect(body.tags.some((tag) => tag.id === tagId)).toBe(true);
    expect(
      body.taskTags.some(
        (entry) => entry.task_id === taskId && entry.tag_id === tagId,
      ),
    ).toBe(true);
  });

  it("uploads, lists, downloads, and removes an attachment", async () => {
    const boundary = "----morrow-test-boundary";
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="note.txt"',
      "Content-Type: text/plain",
      "",
      "attachment body",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/attachments`,
      headers: {
        cookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(uploaded.statusCode).toBe(201);
    const attachmentId = (uploaded.json() as { id: string }).id;
    const list = await api("GET", `/api/tasks/${taskId}/attachments`);
    expect(
      (list.json() as { attachments: Array<{ id: string }> }).attachments.some(
        (entry) => entry.id === attachmentId,
      ),
    ).toBe(true);
    const download = await api("GET", `/api/attachments/${attachmentId}/download`);
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe("attachment body");
    const removed = await api("DELETE", `/api/attachments/${attachmentId}`);
    expect(removed.statusCode).toBe(200);
  });

  it("adds, completes, and removes a subtask", async () => {
    const created = await api("POST", `/api/tasks/${taskId}/subtasks`, {
      payload: { title: "Draft outline" },
    });
    expect(created.statusCode).toBe(201);
    const subtaskId = (created.json() as { id: string }).id;
    const patched = await api("PATCH", `/api/subtasks/${subtaskId}`, {
      payload: { done: true },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { done: number }).done).toBe(1);
    const list = await api("GET", `/api/tasks/${taskId}/subtasks`);
    expect((list.json() as { subtasks: unknown[] }).subtasks).toHaveLength(1);
    const removed = await api("DELETE", `/api/subtasks/${subtaskId}`);
    expect(removed.statusCode).toBe(200);
    const empty = await api("GET", `/api/tasks/${taskId}/subtasks`);
    expect((empty.json() as { subtasks: unknown[] }).subtasks).toHaveLength(0);
  });
});

describe("capture tokens and email ingestion", () => {
  it("creates a token and quick-captures with it", async () => {
    const created = await api("POST", "/api/capture/tokens", {
      payload: { name: "Shortcuts" },
    });
    expect(created.statusCode).toBe(201);
    captureToken = (created.json() as { token: string }).token;
    expect(captureToken).toMatch(/^morrow_/);

    const quick = await app.inject({
      method: "POST",
      url: "/api/capture/quick",
      headers: { authorization: `Bearer ${captureToken}` },
      payload: { text: "Call Sam tomorrow at 9 #p2 @Shared projects" },
    });
    expect(quick.statusCode).toBe(201);
    const body = quick.json() as {
      task: { title: string; priority: number; list_id: string };
      parsed: { title: string };
    };
    expect(body.task.title).toContain("Call Sam");
    expect(body.task.priority).toBe(3);
    expect(body.task.list_id).toBe(listId);

    const email = await app.inject({
      method: "POST",
      url: `/api/inbound/email?token=${encodeURIComponent(captureToken)}`,
      payload: { subject: "Renew passport", text: "next Friday" },
    });
    expect(email.statusCode).toBe(201);
    expect((email.json() as { task: { title: string } }).task.title).toContain(
      "Renew passport",
    );
  });

  it("dedupes a retried quick capture by Idempotency-Key", async () => {
    const headers = {
      authorization: `Bearer ${captureToken}`,
      "idempotency-key": "shortcut-delivery-0001",
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/capture/quick",
      headers,
      payload: { text: "Idempotent quick capture" },
    });
    expect(first.statusCode).toBe(201);
    const firstTask = (first.json() as { task: { id: string } }).task;

    const retry = await app.inject({
      method: "POST",
      url: "/api/capture/quick",
      headers,
      payload: { text: "Idempotent quick capture" },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect((retry.json() as { task: { id: string } }).task.id).toBe(firstTask.id);

    const count = getDb()
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = ?")
      .get("Idempotent quick capture") as { n: number };
    expect(count.n).toBe(1);
  });

  it("dedupes retried email deliveries by provider Message-ID", async () => {
    const payload = {
      subject: "Idempotent email capture",
      text: "tomorrow at 10",
      headers: "Message-ID: <delivery-0001@example.test>\r\nFrom: sender@example.test",
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/inbound/email?token=${encodeURIComponent(captureToken)}`,
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstTask = (first.json() as { task: { id: string } }).task;

    const retry = await app.inject({
      method: "POST",
      url: `/api/inbound/email?token=${encodeURIComponent(captureToken)}`,
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect((retry.json() as { task: { id: string } }).task.id).toBe(firstTask.id);

    const count = getDb()
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE ?")
      .get("Idempotent email capture%") as { n: number };
    expect(count.n).toBe(1);
  });

  it("creates a separate CalDAV-scoped token", async () => {
    const created = await api("POST", "/api/capture/tokens", {
      payload: { name: "Calendar", kind: "caldav" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { token: string; kind: string };
    expect(body.kind).toBe("caldav");
    caldavToken = body.token;
  });
});

describe("multi-account list sharing", () => {
  it("creates a second account and shares a list with it", async () => {
    const stepUp = await api("POST", "/api/auth/password", {
      payload: { password: PASSWORD },
    });
    expect(stepUp.statusCode).toBe(200);
    const partner = await api("POST", "/api/users", {
      payload: {
        username: "partner",
        password: PARTNER_PASSWORD,
        timezone: "UTC",
      },
    });
    expect(partner.statusCode).toBe(201);
    const share = await api("POST", `/api/lists/${listId}/share`, {
      payload: { username: "partner" },
    });
    expect(share.statusCode).toBe(201);

    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { username: "partner", password: PARTNER_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const partnerCookie = cookieOf(login);

    const lists = await api("GET", "/api/lists", {
      sessionCookie: partnerCookie,
    });
    expect(lists.statusCode).toBe(200);
    expect(
      (lists.json() as { lists: Array<{ id: string; shared: number }> }).lists.some(
        (entry) => entry.id === listId && entry.shared === 1,
      ),
    ).toBe(true);

    const tasks = await api("GET", `/api/tasks?view=all&listId=${listId}`, {
      sessionCookie: partnerCookie,
    });
    expect(tasks.statusCode).toBe(200);
    const visible = (tasks.json() as { tasks: Array<{ id: string }> }).tasks;
    expect(visible.some((task) => task.id === taskId)).toBe(true);
  });
});

describe("calendar integration", () => {
  it("serves an iCalendar feed with a CalDAV token", async () => {
    const feed = await app.inject({
      method: "GET",
      url: `/api/calendar.ics?token=${encodeURIComponent(caldavToken)}`,
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers["content-type"]).toContain("text/calendar");
    expect(feed.body).toContain("BEGIN:VCALENDAR");
    expect(feed.body).toContain("Product task");
  });

  it("discovers a CalDAV principal and calendar", async () => {
    const basic = Buffer.from(`owner:${caldavToken}`).toString("base64");
    const principal = await app.inject({
      method: "PROPFIND",
      url: "/caldav/principal/",
      headers: {
        authorization: `Basic ${basic}`,
        depth: "0",
        "content-type": "application/xml",
      },
    });
    expect(principal.statusCode).toBe(207);
    expect(principal.body).toContain("/caldav/calendars/");

    const putId = newId();
    const put = await app.inject({
      method: "PUT",
      url: `/caldav/calendars/inbox/${putId}.ics`,
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "text/calendar",
      },
      payload: [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VTODO",
        `UID:${putId}@morrow`,
        "SUMMARY:CalDAV created",
        "DUE:20261110T090000Z",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-PT10M",
        "END:VALARM",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n"),
    });
    expect([201, 204]).toContain(put.statusCode);

    const task = await api("GET", `/api/tasks/${putId}`);
    expect(task.statusCode).toBe(200);
    expect((task.json() as { title: string }).title).toBe("CalDAV created");
  });
});
