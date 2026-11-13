/**
 * Internal MCP Streamable HTTP endpoint (plan §1, §6, §8).
 *
 * - Stateless Streamable HTTP on :3001.
 * - Agent-network only: bind to MCP_HOST (compose sets the app's agent-network
 *   address), never 0.0.0.0, and never publish this port or proxy it through
 *   Caddy. Without MCP_HOST the listener falls back to 127.0.0.1 for local dev.
 * - /healthz is an unauthenticated liveness probe on that same agent-only
 *   listener; it inherits the bind address, so edge/Caddy cannot reach it.
 * - Bearer token hashed at rest, scoped read|write|propose, expiry, revoke,
 *   last_used, kill switch, constant-time compare.
 * - Host/Origin allowlist, body cap, HTTP rate limits, and per-tool quotas.
 * - Only reminders_* tools are registered. There is no delete tool.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Fastify from "fastify";
import { getDb, type BetterDb } from "@morrow/db";
import {
  createMcpHandler,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createRemindersMcpServer,
  MCP_TOOL_NAMES,
  quotas,
  randomToken,
  sha256,
  TaskStore,
  ownerUserId,
  type McpAuthContext,
} from "@morrow/agent";
import { isMaintenanceActive } from "./maintenance.js";

const MCP_SETTINGS_KEY = "mcp.tokens.v1";
const MCP_ENABLED_KEY = "mcp.enabled";
const MCP_MAX_BODY_BYTES = 256 * 1024;
const MCP_HTTP_PER_MINUTE = 120;
const MCP_HTTP_PER_IP_PER_MINUTE = 240;

export interface McpTokenRecord {
  id: string;
  name: string;
  tokenHash: string;
  scopes: Array<"read" | "write" | "propose">;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface McpAuth {
  tokenId: string;
  scopes: string[];
}

interface AuthenticatedRequest extends FastifyRequest {
  mcpAuth?: McpAuth;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

const httpBuckets = new Map<string, RateBucket>();
const lastUsedWrite = new Map<string, number>();

function readTokens(db: BetterDb): McpTokenRecord[] {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ? AND deleted_at IS NULL")
      .get(MCP_SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return [];
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is McpTokenRecord =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as McpTokenRecord).id === "string" &&
          typeof (item as McpTokenRecord).tokenHash === "string",
      )
      .map((item) => ({
        ...item,
        scopes: Array.isArray(item.scopes)
          ? (item.scopes.filter((scope) =>
              ["read", "write", "propose"].includes(scope),
            ) as McpTokenRecord["scopes"])
          : [],
      }));
  } catch {
    return [];
  }
}

function writeTokens(db: BetterDb, tokens: McpTokenRecord[]): void {
  db.prepare(
    `INSERT INTO settings (key, value, rev, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       rev = settings.rev + 1, updated_at = excluded.updated_at,
       deleted_at = NULL`,
  ).run(MCP_SETTINGS_KEY, JSON.stringify(tokens), new Date().toISOString());
}

export function mcpGloballyEnabled(db: BetterDb): boolean {
  if ((process.env["MCP_ENABLED"] ?? "").toLowerCase() === "false") return false;
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ? AND deleted_at IS NULL")
      .get(MCP_ENABLED_KEY) as { value: string } | undefined;
    if (!row) return true;
    return JSON.parse(row.value) !== false;
  } catch {
    return true;
  }
}

export function setMcpEnabled(db: BetterDb, enabled: boolean): void {
  db.prepare(
    `INSERT INTO settings (key, value, rev, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       rev = settings.rev + 1, updated_at = excluded.updated_at,
       deleted_at = NULL`,
  ).run(MCP_ENABLED_KEY, JSON.stringify(enabled), new Date().toISOString());
}

function readTokenFromEnv(): string | null {
  const env = (process.env["REMINDERS_MCP_TOKEN"] ?? "").trim();
  if (env) return env;
  try {
    const dir =
      process.env["SECRETS_DIR"] ?? path.join(process.cwd(), "data", "secrets");
    const value = fs
      .readFileSync(path.join(dir, "reminders_mcp_token"), "utf8")
      .trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Upsert the primary token from REMINDERS_MCP_TOKEN. The plaintext token is
 * never persisted; only its SHA-256 hash reaches SQLite.
 */
export function ensureMcpTokenFromEnv(
  db: BetterDb = getDb(),
): McpTokenRecord | null {
  const token = readTokenFromEnv();
  if (!token) return null;
  const hash = sha256(token);
  const tokens = readTokens(db);
  const existingIndex = tokens.findIndex((record) => record.id === "primary");
  const now = new Date().toISOString();
  if (existingIndex >= 0) {
    const existing = tokens[existingIndex]!;
    if (existing.tokenHash === hash) return existing;
    if (existing.revokedAt) {
      // A revoked token must stay revoked even if an old env is still around.
      return existing;
    }
    const updated: McpTokenRecord = { ...existing, tokenHash: hash, createdAt: now };
    tokens[existingIndex] = updated;
    writeTokens(db, tokens);
    return updated;
  }
  const record: McpTokenRecord = {
    id: "primary",
    name: "REMINDERS_MCP_TOKEN",
    tokenHash: hash,
    scopes: ["read", "write", "propose"],
    createdAt: now,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };
  tokens.push(record);
  writeTokens(db, tokens);
  return record;
}

function timingSafeHashEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hashToken(token: string): string {
  return sha256(token);
}

export interface AuthenticateResult {
  ok: boolean;
  reason?: "missing" | "invalid" | "expired" | "revoked";
  auth?: McpAuth;
}

/** Validate a bearer token with a constant-time hash comparison. */
export function authenticateMcpToken(
  db: BetterDb,
  token: string | null,
): AuthenticateResult {
  if (!token) return { ok: false, reason: "missing" };
  if (!mcpGloballyEnabled(db)) return { ok: false, reason: "revoked" };
  const presented = hashToken(token);
  const tokens = readTokens(db);
  let match: McpTokenRecord | null = null;
  let matched = false;
  for (const record of tokens) {
    // Compare every hash to avoid an early-exit timing signal.
    if (timingSafeHashEqual(presented, record.tokenHash)) {
      matched = true;
      match = record;
    }
  }
  if (!matched || !match) return { ok: false, reason: "invalid" };
  if (match.revokedAt) return { ok: false, reason: "revoked" };
  if (match.expiresAt && Date.parse(match.expiresAt) <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  const last = lastUsedWrite.get(match.id) ?? 0;
  if (Date.now() - last > 60_000) {
    lastUsedWrite.set(match.id, Date.now());
    try {
      const next = tokens.map((record) =>
        record.id === match?.id
          ? { ...record, lastUsedAt: new Date().toISOString() }
          : record,
      );
      writeTokens(db, next);
    } catch {
      // last_used is operational metadata; never fail auth for it.
    }
  }
  return {
    ok: true,
    auth: { tokenId: match.id, scopes: [...match.scopes] },
  };
}

export function rotateMcpToken(
  db: BetterDb = getDb(),
  name = "rotated",
  scopes: Array<"read" | "write" | "propose"> = ["read", "write", "propose"],
): { token: string; record: McpTokenRecord } {
  const token = randomToken(32);
  const now = new Date().toISOString();
  const tokens = readTokens(db);
  // Rotation revokes every previous live token, including the env bootstrap
  // token. A restart with an old env cannot silently restore it.
  const revoked = tokens.map((record) =>
    record.revokedAt ? record : { ...record, revokedAt: now },
  );
  const record: McpTokenRecord = {
    id: `tok_${randomToken(9)}`,
    name,
    tokenHash: hashToken(token),
    scopes,
    createdAt: now,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };
  revoked.push(record);
  writeTokens(db, revoked);
  return { token, record };
}

export function revokeMcpToken(db: BetterDb, id: string): boolean {
  const tokens = readTokens(db);
  const next = tokens.map((record) =>
    record.id === id
      ? { ...record, revokedAt: new Date().toISOString() }
      : record,
  );
  if (JSON.stringify(next) === JSON.stringify(tokens)) return false;
  writeTokens(db, next);
  return true;
}

export function mcpStatus(db: BetterDb = getDb()): {
  enabled: boolean;
  tokens: Array<Omit<McpTokenRecord, "tokenHash">>;
} {
  return {
    enabled: mcpGloballyEnabled(db),
    tokens: readTokens(db).map(({ tokenHash, ...rest }) => {
      void tokenHash;
      return rest;
    }),
  };
}

function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function allowedHostnames(): string[] {
  const raw =
    process.env["MCP_ALLOWED_HOSTS"] ??
    "app,localhost,127.0.0.1,::1,[::1]";
  return raw
    .split(",")
    .map((entry) => entry.trim().replace(/^\[|\]$/g, "").toLowerCase())
    .filter(Boolean);
}

function hitHttpBucket(key: string, max: number): boolean {
  const now = Date.now();
  const existing = httpBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    httpBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  existing.count += 1;
  return existing.count <= max;
}

function jsonRpcError(
  reply: import("fastify").FastifyReply,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  for (const [key, value] of Object.entries(headers)) reply.header(key, value);
  void reply
    .code(status)
    .header("content-type", "application/json")
    .send({ jsonrpc: "2.0", id: null, error: { code, message } });
}

export interface McpServerOptions {
  db?: BetterDb;
  emit?: (event: {
    type: string;
    conversationId: string | null;
    data: Record<string, unknown>;
  }) => void;
  logger?: { warn: (value: unknown, message?: string) => void; info?: (value: unknown, message?: string) => void };
  /**
   * False after a restore: the backup deliberately excludes MCP credential
   * hashes, so do not resurrect the old env token. The owner logs in and
   * rotates a fresh token instead.
   */
  bootstrapEnvToken?: boolean;
}

/**
 * Build the internal MCP server without listening. Tests use `inject`; main()
 * starts it only when a token and MCP_PORT are configured.
 */
export async function buildMcpApp(options: McpServerOptions = {}): Promise<FastifyInstance> {
  const db = options.db ?? getDb();
  if (options.bootstrapEnvToken !== false) ensureMcpTokenFromEnv(db);

  const app = Fastify({
    logger: false,
    bodyLimit: MCP_MAX_BODY_BYTES,
  });

  const handler = createMcpHandler(
    (ctx) => {
      const auth = authFromInfo(ctx.authInfo);
      return createRemindersMcpServer({
        store: new TaskStore(db, ownerUserId(db) ?? undefined),
        quotas,
        auth,
        actorId: auth.tokenId,
        emit: options.emit,
      });
    },
    {
      legacy: "stateless",
      maxRequestBodySize: MCP_MAX_BODY_BYTES,
      responseMode: "auto",
      onerror: (error) => options.logger?.warn({ err: error }, "mcp handler error"),
    },
  );
  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
    onerror: (error) =>
      options.logger?.warn({ err: error }, "mcp node adapter error"),
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/healthz") return;
    if (isMaintenanceActive()) {
      return jsonRpcError(reply, 503, -32000, "Maintenance in progress.", {
        "retry-after": "5",
      });
    }
    const host = hostnameOf(req.headers["host"]);
    const allowed = allowedHostnames();
    if (!host || !allowed.includes(host)) {
      return jsonRpcError(reply, 403, -32000, "Forbidden host.");
    }
    const origin = req.headers["origin"];
    if (typeof origin === "string" && origin.trim() !== "") {
      const originHost = hostnameOf(origin);
      if (!originHost || !allowed.includes(originHost)) {
        return jsonRpcError(reply, 403, -32000, "Forbidden origin.");
      }
    }
    if (!mcpGloballyEnabled(db)) {
      return jsonRpcError(reply, 503, -32000, "MCP is disabled.");
    }
    const header = req.headers["authorization"];
    const raw =
      typeof header === "string" && header.toLowerCase().startsWith("bearer ")
        ? header.slice(7).trim()
        : null;
    const result = authenticateMcpToken(db, raw);
    if (!result.ok || !result.auth) {
      return jsonRpcError(
        reply,
        401,
        -32001,
        result.reason === "expired"
          ? "Token expired."
          : result.reason === "revoked"
            ? "Token revoked."
            : "Unauthorized.",
        { "www-authenticate": 'Bearer realm="morrow-mcp"' },
      );
    }
    if (
      !hitHttpBucket(`token:${result.auth.tokenId}`, MCP_HTTP_PER_MINUTE) ||
      !hitHttpBucket(`ip:${req.ip}`, MCP_HTTP_PER_IP_PER_MINUTE)
    ) {
      return jsonRpcError(reply, 429, -32000, "Too many MCP requests.", {
        "retry-after": "60",
      });
    }
    (req as AuthenticatedRequest).mcpAuth = result.auth;
  });

  // Unauthenticated liveness probe on the MCP listener. This stays safe only
  // because the listener is bound to the agent interface (MCP_HOST in compose)
  // or loopback in dev; startMcpServer never defaults to 0.0.0.0. It is not a
  // public endpoint: Caddy and the edge network cannot reach this route, so
  // never move/proxy it to the main app listener. Keep the path/response stable
  // for container probes.
  app.get("/healthz", async (_req, reply) =>
    reply.header("cache-control", "no-store").send({ status: "ok" }),
  );

  app.all("/mcp", async (req, reply) => {
    const auth = (req as AuthenticatedRequest).mcpAuth;
    if (!auth) return;
    reply.hijack();
    // toNodeHandler forwards req.auth into the MCP factory's authInfo.
    (req.raw as unknown as { auth?: unknown }).auth = {
      token: "",
      clientId: auth.tokenId,
      scopes: auth.scopes,
      extra: { tokenId: auth.tokenId, scopes: auth.scopes },
    };
    await nodeHandler(req.raw, reply.raw, req.body);
  });

  app.addHook("onClose", async () => {
    await handler.close();
  });

  return app;
}

function authFromInfo(
  info: import("@modelcontextprotocol/server").AuthInfo | undefined,
): McpAuthContext {
  const extra =
    info?.extra && typeof info.extra === "object"
      ? (info.extra as Record<string, unknown>)
      : {};
  const tokenId =
    typeof extra["tokenId"] === "string"
      ? extra["tokenId"]
      : info?.clientId ?? "mcp";
  const scopes = Array.isArray(info?.scopes) ? info.scopes.map(String) : [];
  return { tokenId, scopes };
}

export interface StartMcpOptions extends McpServerOptions {
  port?: number;
  host?: string;
}

const DEFAULT_MCP_HOST = "127.0.0.1";
const WILDCARD_MCP_HOSTS = new Set(["0.0.0.0", "::", "[::]", "*"]);

let activeMcpServer: FastifyInstance | null = null;
let lastStartOptions: StartMcpOptions | null = null;

/**
 * Resolve the MCP bind address. The default is loopback so a bare `pnpm dev`
 * cannot expose :3001 on a LAN. Compose sets MCP_HOST to the app's static
 * address on the internal `agent` network, which is the only interface the
 * sidecar can reach.
 */
export function resolveMcpHost(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): string {
  const host = (override ?? env["MCP_HOST"] ?? "").trim();
  return host || DEFAULT_MCP_HOST;
}

export function isWildcardMcpHost(host: string): boolean {
  return WILDCARD_MCP_HOSTS.has(host.trim().toLowerCase());
}

export async function startMcpServer(
  options: StartMcpOptions = {},
): Promise<FastifyInstance | null> {
  const db = options.db ?? getDb();
  const token = readTokenFromEnv();
  if (!token) {
    options.logger?.warn(
      {},
      "MCP not started: REMINDERS_MCP_TOKEN is not configured (AI-off is supported).",
    );
    return null;
  }
  if (!mcpGloballyEnabled(db)) {
    options.logger?.warn({}, "MCP not started: kill switch is off.");
    return null;
  }
  const port = options.port ?? Number(process.env["MCP_PORT"] ?? 3001);
  const host = resolveMcpHost(process.env, options.host);
  if (isWildcardMcpHost(host)) {
    // Explicit opt-out of the safe default: keep it visible without taking the
    // reminders core offline. Compose never sets a wildcard address.
    options.logger?.warn(
      { host, port },
      "MCP_HOST is a wildcard address; :3001 is reachable on every attached network (including edge). Bind it to the agent-network address instead.",
    );
  }
  const app = await buildMcpApp(options);
  await app.listen({ host, port });
  activeMcpServer = app;
  lastStartOptions = { ...options, db: undefined };
  options.logger?.info?.(
    { host, port, tools: MCP_TOOL_NAMES.length },
    "MCP listener is internal (agent network only); never publish or proxy it",
  );
  return app;
}

/** Stop the internal MCP listener (shutdown and pre-restore drain). */
export async function stopMcpServer(): Promise<void> {
  const app = activeMcpServer;
  activeMcpServer = null;
  if (!app) return;
  try {
    await app.close();
  } catch {
    // Listener shutdown is best-effort; the DB swap must still proceed.
  }
}

export function getActiveMcpServer(): FastifyInstance | null {
  return activeMcpServer;
}

/**
 * Rebuild the MCP listener after a restore reopened the DB singleton. The new
 * Fastify instance resolves `getDb()` lazily, so its TaskStore uses the new
 * handle. A failure is logged by the caller and never fails the restore
 * response (the reminder core remains usable without MCP).
 */
export async function restartMcpServerAfterRestore(): Promise<boolean> {
  const options = lastStartOptions;
  if (!options) return false;
  await stopMcpServer();
  await startMcpServer({ ...options, db: undefined, bootstrapEnvToken: false });
  return true;
}
