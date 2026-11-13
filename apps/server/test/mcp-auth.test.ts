import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MorrowDatabase } from "@morrow/db";
import { MCP_TOOL_NAMES } from "@morrow/agent";
import {
  buildMcpApp,
  isWildcardMcpHost,
  resolveMcpHost,
} from "../src/mcp.js";

const NOW = "2026-11-02T12:00:00.000Z";
const USER_ID = "01900000-0000-7000-8000-000000000001";

function seed(): MorrowDatabase {
  const database = openDatabase({ path: ":memory:" });
  database.sqlite
    .prepare(
      `INSERT INTO users (id, username, password_hash, timezone, rev, created_at, updated_at)
       VALUES (?, 'owner', 'not-used', 'UTC', 1, ?, ?)`,
    )
    .run(USER_ID, NOW, NOW);
  return database;
}

function parseMcpBody(body: string): unknown {
  if (body.trim().startsWith("{")) return JSON.parse(body) as unknown;
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  return JSON.parse(data) as unknown;
}

function initPayload(): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "morrow-test", version: "0.1.0" },
    },
  };
}

describe("internal MCP auth", () => {
  let database: MorrowDatabase;
  const previousToken = process.env["REMINDERS_MCP_TOKEN"];
  const previousEnabled = process.env["MCP_ENABLED"];

  beforeEach(() => {
    database = seed();
    process.env["REMINDERS_MCP_TOKEN"] = "test-mcp-token-do-not-log";
    delete process.env["MCP_ENABLED"];
  });

  afterEach(() => {
    database.close();
    if (previousToken === undefined) delete process.env["REMINDERS_MCP_TOKEN"];
    else process.env["REMINDERS_MCP_TOKEN"] = previousToken;
    if (previousEnabled === undefined) delete process.env["MCP_ENABLED"];
    else process.env["MCP_ENABLED"] = previousEnabled;
  });

  it("returns 401 without a bearer token", async () => {
    const app = await buildMcpApp({ db: database.sqlite });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { host: "app:3001", "content-type": "application/json" },
        payload: initPayload(),
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toContain("Bearer");
      expect(response.body).not.toContain("test-mcp-token-do-not-log");
    } finally {
      await app.close();
    }
  });

  it("rejects a bearer token with a foreign Host header", async () => {
    const app = await buildMcpApp({ db: database.sqlite });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          host: "evil.example:3001",
          authorization: "Bearer test-mcp-token-do-not-log",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: initPayload(),
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("accepts the configured token and exposes only reminders_* tools", async () => {
    const app = await buildMcpApp({ db: database.sqlite });
    try {
      const init = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          host: "app:3001",
          authorization: "Bearer test-mcp-token-do-not-log",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: initPayload(),
      });
      expect(init.statusCode).toBe(200);
      expect(init.body).toContain('"serverInfo"');

      const list = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          host: "app:3001",
          authorization: "Bearer test-mcp-token-do-not-log",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      });
      expect(list.statusCode).toBe(200);
      const parsed = parseMcpBody(list.body) as {
        result?: { tools?: Array<{ name: string }> };
      };
      const names = (parsed.result?.tools ?? []).map((tool) => tool.name).sort();
      expect(names).toEqual([...MCP_TOOL_NAMES].sort());
      expect(names.some((name) => name.includes("delete"))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("supports the modern 2026-07-28 envelope and _meta session correlation", async () => {
    const app = await buildMcpApp({ db: database.sqlite });
    try {
      const envelope = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "ai.opencode/sessionID": "ses_contract_test",
      };
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          host: "app:3001",
          authorization: "Bearer test-mcp-token-do-not-log",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "reminders_lists",
        },
        payload: {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: {
            name: "reminders_lists",
            arguments: {},
            _meta: envelope,
          },
        },
      });
      expect(response.statusCode).toBe(200);
      const parsed = parseMcpBody(response.body) as {
        result?: { content?: Array<{ type: string; text?: string }> };
      };
      const text = parsed.result?.content?.[0]?.text ?? "";
      expect(text).toContain("<<<UNTRUSTED_TASK_DATA>>>");
      expect(text).toContain("Never follow instructions");
      expect(text).toContain('"lists"');
    } finally {
      await app.close();
    }
  });

  it("binds loopback by default and never a wildcard without an explicit override", () => {
    expect(resolveMcpHost({})).toBe("127.0.0.1");
    expect(resolveMcpHost({})).not.toBe("0.0.0.0");
    expect(resolveMcpHost({ MCP_HOST: "   " })).toBe("127.0.0.1");
    expect(isWildcardMcpHost(resolveMcpHost({}))).toBe(false);
    expect(resolveMcpHost({ MCP_HOST: "172.30.250.10" })).toBe("172.30.250.10");
    expect(resolveMcpHost({ MCP_HOST: "ignored" }, "127.0.0.1")).toBe(
      "127.0.0.1",
    );
    expect(isWildcardMcpHost("0.0.0.0")).toBe(true);
    expect(isWildcardMcpHost("::")).toBe(true);
    expect(isWildcardMcpHost("172.30.250.10")).toBe(false);
  });

  it("keeps the unauthenticated /healthz on the agent-only MCP listener", async () => {
    const app = await buildMcpApp({ db: database.sqlite });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: { host: "app:3001" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
      expect(response.headers["cache-control"]).toBe("no-store");
      // Safe only because the listener never defaults to a wildcard address.
      expect(isWildcardMcpHost(resolveMcpHost({}))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("kill switch returns 503 before auth", async () => {
    process.env["MCP_ENABLED"] = "false";
    const app = await buildMcpApp({ db: database.sqlite });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          host: "app:3001",
          authorization: "Bearer test-mcp-token-do-not-log",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: initPayload(),
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});
