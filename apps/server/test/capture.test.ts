/**
 * M1 capture parser tests (§5 `POST /api/capture/parse`, §11 M1).
 *
 * The deterministic parser is pinned with a fixed clock (direct unit calls)
 * plus HTTP contract checks: 503 with the M4 flag when AI is requested,
 * 400 on empty text, and timezone validation.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { closeDb } from "@morrow/db";
import { resetConfigCache } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { parseCapture } from "../src/captureParse.js";

const PASSWORD = "correct-horse-battery-staple-99";
const SETUP_TOKEN = "test-setup-token-capture-01";

// Wednesday 2026-11-04 10:00 UTC — pins weekday/date expectations.
const FIXED_NOW = new Date("2026-11-04T10:00:00.000Z");

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

beforeAll(async () => {
  for (const k of ["DATABASE_PATH", "SETUP_TOKEN", "APP_URL", "SECRETS_DIR"]) {
    savedEnv[k] = process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "morrow-m1-capture-"));
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

describe("parseCapture (deterministic, fixed clock)", () => {
  it("parses 'tomorrow 9am' as a timed task", () => {
    const out = parseCapture("Buy milk tomorrow 9am", "UTC", FIXED_NOW);
    expect(out.title).toBe("Buy milk");
    expect(out.dueAt).toBe("2026-11-05T09:00:00.000Z");
    expect(out.dueDate).toBeNull();
    expect(out.allDay).toBe(false);
    expect(out.remindAt).toBe("2026-11-05T09:00:00.000Z");
    expect(out.rrule).toBeNull();
    expect(out.confidence).toBeGreaterThan(0.6);
  });

  it("resolves a bare weekday to its date (all-day)", () => {
    const out = parseCapture("Water the plants Fri", "UTC", FIXED_NOW);
    expect(out.title).toBe("Water the plants");
    expect(out.dueDate).toBe("2026-11-06");
    expect(out.allDay).toBe(true);
    expect(out.reminderTimeLocal).toBe("09:00:00");
  });

  it("parses relative 'in 2h' as timed", () => {
    const out = parseCapture("Call mom in 2h", "UTC", FIXED_NOW);
    expect(out.title).toBe("Call mom");
    expect(out.dueAt).toBe("2026-11-04T12:00:00.000Z");
    expect(out.allDay).toBe(false);
  });

  it("parses 'everyday' as a daily series", () => {
    const out = parseCapture("Standup everyday", "UTC", FIXED_NOW);
    expect(out.title).toBe("Standup");
    expect(out.rrule).toBe("RRULE:FREQ=DAILY");
    expect(out.dtstartLocal).toBe("2026-11-04T09:00:00");
    expect(out.dueDate).toBe("2026-11-04");
    expect(out.allDay).toBe(true);
  });

  it("anchors 'every Mon' on the coming Monday, not today", () => {
    const out = parseCapture("Gym every Mon", "UTC", FIXED_NOW);
    expect(out.title).toBe("Gym");
    expect(out.rrule).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO");
    expect(out.dueDate).toBe("2026-11-09");
    expect(out.dtstartLocal).toBe("2026-11-09T09:00:00");
  });

  it("extracts priority #p1 and list @name", () => {
    const out = parseCapture("Read #p1 @home", "UTC", FIXED_NOW);
    expect(out.title).toBe("Read");
    expect(out.priority).toBe(4);
    expect(out.listName).toBe("home");
    expect(out.dueAt).toBeNull();
    expect(out.dueDate).toBeNull();
  });
});

describe("POST /api/capture/parse (contract)", () => {
  it("serves the deterministic parser over HTTP", async () => {
    const res = await api("POST", "/api/capture/parse", {
      payload: { text: "Buy milk tomorrow 9am", timezone: "UTC" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(typeof body["title"]).toBe("string");
    expect(body["dueAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof body["confidence"]).toBe("number");
  });

  it("returns 503 with the M4 flag when AI is requested (no LLM call)", async () => {
    const res = await api("POST", "/api/capture/parse", {
      payload: { text: "Buy milk tomorrow", ai: true },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers["x-morrow-m4"]).toBe("capture-ai");
    expect((res.json() as { code?: string }).code).toBe("ai_unavailable");
  });

  it("rejects empty text and unknown timezones", async () => {
    const empty = await api("POST", "/api/capture/parse", {
      payload: { text: "   " },
    });
    expect(empty.statusCode).toBe(400);
    const badTz = await api("POST", "/api/capture/parse", {
      payload: { text: "Buy milk", timezone: "Mars/Olympus" },
    });
    expect(badTz.statusCode).toBe(400);
  });
});
