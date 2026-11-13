#!/usr/bin/env node
/**
 * Harness smoke test: live prompt + tool prompt against the local app.
 *
 * 1. Logs in (or runs setup first) and creates an assistant conversation.
 * 2. Live: sends "Say pong.", polls messages until `running` is false,
 *    asserts the assistant text contains `pong` and no `lastError`.
 * 3. Tool: sends "Create a task called Harness smoke tomorrow at 9.",
 *    asserts a task appears via GET /api/tasks, asserts an activity/audit
 *    row for `reminders_create`, calls undo, asserts the task is gone.
 *
 * Usage:
 *   APP_URL=http://127.0.0.1:4605 APP_PASSWORD=... \
 *     node deploy/harness-smoke.mjs [--live-only|--tool-only]
 *
 * Exits non-zero on any mismatch. Spends model tokens (one short reply +
 * one tool run); the stub-provider test (no tokens) is separate.
 */
import process from "node:process";

const APP_URL = (process.env.APP_URL || "http://127.0.0.1:4605").replace(/\/+$/, "");
const PASSWORD = process.env.APP_PASSWORD || process.env.MORROW_PASSWORD || "";
const SETUP_TOKEN = process.env.SETUP_TOKEN || "harness-setup-token";
const args = new Set(process.argv.slice(2));
const LIVE_ONLY = args.has("--live-only");
const TOOL_ONLY = args.has("--tool-only");

if (!PASSWORD) {
  console.error("harness-smoke: APP_PASSWORD (or MORROW_PASSWORD) is required");
  process.exit(1);
}

let cookie = "";

async function request(path, { method = "GET", body } = {}) {
  const res = await fetch(`${APP_URL}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: res.status, json, text };
}

function assert(cond, message) {
  if (!cond) {
    console.error(`harness-smoke: FAIL: ${message}`);
    process.exit(1);
  }
}

async function ensureAuth() {
  const login = await request("/api/login", {
    method: "POST",
    body: { password: PASSWORD },
  });
  if (login.status === 200) {
    console.log("ok  login");
    return;
  }
  console.log(`login -> ${login.status}; trying setup…`);
  const setup = await request("/api/setup", {
    method: "POST",
    body: { token: SETUP_TOKEN, password: PASSWORD, timezone: "UTC" },
  });
  assert(
    setup.status === 201 || setup.status === 200,
    `setup failed: ${setup.status} ${setup.text.slice(0, 200)}`,
  );
  console.log("ok  setup + login");
}

async function createConversation() {
  const res = await request("/api/assistant/conversations", {
    method: "POST",
    body: { title: "Harness smoke" },
  });
  assert(res.status === 201, `create conversation failed: ${res.status} ${res.text.slice(0, 200)}`);
  const id = res.json?.conversation?.id;
  assert(typeof id === "string" && id, "conversation id missing");
  console.log(`ok  conversation ${id}`);
  return id;
}

async function sendAndWait(conversationId, text, timeoutMs = 120_000) {
  const sent = await request(
    `/api/assistant/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "POST", body: { text } },
  );
  assert(sent.status === 202, `send failed: ${sent.status} ${sent.text.slice(0, 300)}`);
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const res = await request(
      `/api/assistant/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    assert(res.status === 200, `poll failed: ${res.status}`);
    if (!res.json?.running) return res.json;
    if (Date.now() - started > timeoutMs) {
      console.error("harness-smoke: FAIL: run did not finish in time");
      process.exit(1);
    }
  }
}

function assistantTexts(payload) {
  return (payload?.messages ?? [])
    .filter((m) => m.role === "assistant")
    .map((m) => String(m.content ?? ""));
}

if (!TOOL_ONLY) {
  await ensureAuth();
  const conv = await createConversation();
  const result = await sendAndWait(conv, "Say pong.");
  const texts = assistantTexts(result);
  const lastError = result.lastError ?? result.conversation?.lastError ?? null;
  assert(!lastError, `live prompt returned lastError: ${JSON.stringify(lastError)?.slice(0, 300)}`);
  assert(
    texts.some((t) => t.toLowerCase().includes("pong")),
    `live prompt missing pong; got: ${JSON.stringify(texts).slice(0, 500)}`,
  );
  console.log("ok  live prompt contains pong with no lastError");
}

if (!LIVE_ONLY) {
  if (TOOL_ONLY) await ensureAuth();
  const conv = TOOL_ONLY ? await createConversation() : await createConversation();
  // Unique per run so reruns never match a previous smoke task.
  const stamp = new Date().toISOString().slice(11, 19).replaceAll(":", "");
  const title = `Harness smoke ${stamp}`;
  const before = Date.now();
  void before;
  const result = await sendAndWait(conv, `Create a task called ${title} tomorrow at 9.`, 180_000);
  const lastError = result.lastError ?? result.conversation?.lastError ?? null;
  assert(!lastError, `tool prompt returned lastError: ${JSON.stringify(lastError)?.slice(0, 300)}`);

  const tasksRes = await request("/api/tasks?view=all&limit=200");
  assert(tasksRes.status === 200, `task list failed: ${tasksRes.status}`);
  const tasks = tasksRes.json?.tasks ?? tasksRes.json?.items ?? [];
  const task = tasks.find((t) =>
    String(t.title ?? "").toLowerCase().includes(title.toLowerCase()),
  );
  assert(task?.id, `harness smoke task not found; got ${tasks.length} tasks`);
  console.log(`ok  tool prompt created task ${task.id}`);

  // The activity feed is ascending by seq; the new row is at the end.
  // Page forward until we find the smoke task's audit row.
  let row = null;
  let cursor = 0;
  for (let page = 0; page < 20; page += 1) {
    const actRes = await request(`/api/activity?cursor=${cursor}&limit=200`);
    assert(actRes.status === 200, `activity failed: ${actRes.status}`);
    const rows = actRes.json?.activities ?? [];
    // The `reminders_create` MCP tool records audit action `task.create`.
    row = rows.find(
      (r) =>
        (r.action === "task.create" || r.action === "reminders_create") &&
        r.entityId === task.id,
    );
    if (row) break;
    const next = actRes.json?.cursor;
    if (typeof next !== "number" || next <= cursor) break;
    cursor = next;
  }
  assert(row, "no activity/audit row for reminders_create on the smoke task");
  assert(row.batchId, "activity row has no batchId for undo");
  console.log(`ok  audit row ${row.action} batch ${row.batchId}`);

  const undo = await request("/api/assistant/undo", {
    method: "POST",
    body: { batchId: row.batchId },
  });
  assert(undo.status === 200, `undo failed: ${undo.status} ${undo.text.slice(0, 200)}`);

  const after = await request("/api/tasks?view=all&limit=200");
  const afterTasks = after.json?.tasks ?? after.json?.items ?? [];
  const gone = afterTasks.find((t) => t.id === task.id);
  const okGone =
    !gone || gone.deletedAt || gone.status === "done" || gone.status === "cancelled";
  assert(okGone, `smoke task still open after undo: ${JSON.stringify(gone)?.slice(0, 300)}`);
  console.log("ok  undo removed/completed the smoke task");
}

console.log("harness-smoke: passed");
