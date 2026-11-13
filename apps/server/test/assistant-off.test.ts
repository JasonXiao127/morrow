import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PASSWORD = "supersecretpw01";
const SETUP_TOKEN = "test-token-assistant";

let buildApp!: () => Promise<FastifyInstance>;
let app: FastifyInstance;
let cookie = "";

async function setup(): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { token: SETUP_TOKEN, password: PASSWORD, timezone: "UTC" },
  });
  expect(response.statusCode).toBe(201);
  const setCookie = response.headers["set-cookie"];
  const first = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  cookie = String(first).split(";")[0]!;
}

function headers(): Record<string, string> {
  return { cookie, "sec-fetch-site": "same-origin" };
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-assistant-"));
  process.env["NODE_ENV"] = "development";
  process.env["APP_URL"] = "http://127.0.0.1:4578";
  process.env["DATABASE_PATH"] = path.join(dir, "morrow.db");
  process.env["SECRETS_DIR"] = path.join(dir, "secrets");
  process.env["SETUP_TOKEN"] = SETUP_TOKEN;
  delete process.env["OPENCODE_URL"];
  delete process.env["OPENCODE_PASSWORD"];
  delete process.env["REMINDERS_MCP_TOKEN"];
  fs.mkdirSync(process.env["SECRETS_DIR"]!, { recursive: true });
  const { closeDb } = await import("@morrow/db");
  closeDb();
  const { resetConfigCache } = await import("../src/config.js");
  resetConfigCache();
  ({ buildApp } = await import("../src/index.js"));
  app = await buildApp();
  await setup();
});

afterAll(async () => {
  try {
    await app.close();
  } catch {
    // ignore
  }
  const { closeDb } = await import("@morrow/db");
  closeDb();
});

describe("assistant AI-off path", () => {
  it("reports the assistant as optional and keeps conversations readable", async () => {
    const status = await app.inject({
      method: "GET",
      url: "/api/assistant/status",
      headers: headers(),
    });
    expect(status.statusCode).toBe(200);
    const body = status.json() as {
      status: { enabled: boolean; available: boolean; status: string };
    };
    expect(body.status.enabled).toBe(false);
    expect(body.status.available).toBe(false);
    expect(body.status.status).toBe("not_configured");

    const created = await app.inject({
      method: "POST",
      url: "/api/assistant/conversations",
      headers: headers(),
      payload: { title: "Offline notes" },
    });
    expect(created.statusCode).toBe(201);
    const conversation = (created.json() as { conversation: { id: string } })
      .conversation;
    const messages = await app.inject({
      method: "GET",
      url: `/api/assistant/conversations/${conversation.id}/messages`,
      headers: headers(),
    });
    expect(messages.statusCode).toBe(200);
    expect((messages.json() as { messages: unknown[] }).messages).toHaveLength(0);

    const prompt = await app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversation.id}/messages`,
      headers: headers(),
      payload: { text: "Plan my day" },
    });
    expect(prompt.statusCode).toBe(503);
    const problem = prompt.json() as { code?: string };
    expect(problem.code).toBe("agent_not_configured");
  });

  it("creates, applies, and undoes a deterministic plan proposal", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: {
        ...headers(),
        "idempotency-key": "01900000-0000-7000-8000-000000000901",
      },
      payload: {
        id: "01900000-0000-7000-8000-000000000901",
        title: "Unscheduled errand",
        allDay: false,
      },
    });
    expect(created.statusCode).toBe(201);

    const planned = await app.inject({
      method: "POST",
      url: "/api/assistant/plan-my-day",
      headers: headers(),
      payload: { timezone: "UTC" },
    });
    expect(planned.statusCode).toBe(200);
    const plan = planned.json() as {
      proposal: {
        id: string;
        baseRev: number;
        payloadHash: string;
        status: string;
        operations: unknown[];
      } | null;
      summary: string;
    };
    expect(plan.proposal).not.toBeNull();
    expect(plan.proposal?.operations.length).toBeGreaterThan(0);
    expect(plan.proposal?.status).toBe("pending");

    const applied = await app.inject({
      method: "POST",
      url: `/api/proposals/${plan.proposal!.id}/apply`,
      headers: headers(),
      payload: {
        operations: [0],
        baseRev: plan.proposal!.baseRev,
        payloadHash: plan.proposal!.payloadHash,
      },
    });
    expect(applied.statusCode).toBe(200);
    expect((applied.json() as { applied: number }).applied).toBe(1);

    const all = await app.inject({
      method: "GET",
      url: "/api/proposals?status=all",
      headers: headers(),
    });
    const allProposals = (all.json() as { proposals: Array<{ status: string }> })
      .proposals;
    expect(allProposals.some((item) => item.status === "applied")).toBe(true);

    const after = await app.inject({
      method: "GET",
      url: "/api/tasks?view=all&limit=200",
      headers: headers(),
    });
    const tasks = (
      after.json() as { tasks: Array<{ id: string; due_at?: string | null }> }
    ).tasks;
    const task = tasks.find((item) => item.id === "01900000-0000-7000-8000-000000000901");
    expect(task?.due_at).toBeTruthy();

    const undone = await app.inject({
      method: "POST",
      url: `/api/proposals/${plan.proposal!.id}/undo`,
      headers: headers(),
    });
    expect(undone.statusCode).toBe(200);
    const restored = await app.inject({
      method: "GET",
      url: "/api/tasks?view=all&limit=200",
      headers: headers(),
    });
    const restoredTasks = (
      restored.json() as { tasks: Array<{ id: string; due_at?: string | null }> }
    ).tasks;
    expect(
      restoredTasks.find(
        (item) => item.id === "01900000-0000-7000-8000-000000000901",
      )?.due_at,
    ).toBeNull();
  });
});
