/**
 * API routes (§5 contract, skeleton scope):
 *
 *   POST /api/setup            setup token → atomic first user → session
 *   POST /api/login            Argon2id verify (uniform errors, rehash)
 *   POST /api/logout           revoke current session
 *   GET  /api/auth/session     current session
 *   POST /api/auth/password    step-up password confirmation
 *   GET  /api/auth/sessions    session list (no token material)
 *   DELETE /api/auth/sessions/:id  revoke (step-up for non-current)
 *   GET  /api/bootstrap        user, settings, lists, tasks, serverTime,
 *                              maxRev, cursor, VAPID pubkey, agent stub
 *   GET  /healthz              liveness (no auth, no DB)
 *   GET  /readyz               internal: DB + scheduler + OpenCode
 *
 * Cross-cutting (§5):
 * - Errors: application/problem+json {type,title,status,detail,code,traceId}.
 * - ETag: bootstrap sends `ETag: "rev-N"`; `requireIfMatch()` + 428/412
 *   helpers are provided for M1 task/list mutations (If-Match required on
 *   PATCH/DELETE/snooze/restore; missing → 428; stale → 412; semantic → 409).
 * - Idempotency: `Idempotency-Key` on POST setup replays the stored result
 *   from the `operations` table; M1 wires the same helper into task writes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDb, migrationStatus, resolveDatabasePath } from "@morrow/db";
import {
  TASK_ACCESS_SQL,
  canAccessList,
  canAccessTask,
} from "./access.js";
import {
  activityToJson,
  getActivity,
  listActivity,
  recordActivity,
  undoActivity,
  ActivityError,
  type ActivityDb,
  type RecordActivityInput,
} from "./activity.js";
import {
  resolveBackupMaxBytes,
  BackupVerificationError,
  exportBackup,
  getBackupRun,
  isSecretLikeKey,
  listBackupRuns,
  readBackupRunFile,
  runBackupNow,
  stripSecretSettings,
  verifyUploadBackupAsync,
  type BackupDb,
} from "./backup.js";
import {
  assertRestoreConfirm,
  computeRestoreDiff,
  readLiveBackupData,
  restoreDatabaseFromBackup,
  RestoreError,
} from "./restore.js";
import {
  etagForRev,
  isValidTimeZone,
  loginRequestSchema,
  newId,
  nowIso,
  parseIfMatch,
  setupRequestSchema,
  stepUpRequestSchema,
} from "@morrow/shared";
import {
  SESSION_COOKIE,
  authenticateRequest,
  countUsers,
  createFirstUserAtomic,
  createSession,
  createUser,
  confirmStepUp,
  getSessionByToken,
  getUserByUsername,
  hashPassword,
  isOwner,
  isStepUpFresh,
  listSessions,
  listUsers,
  readSessionToken,
  revokeSession,
  setupTokensEqual,
  verifyLoginPassword,
  verifyPassword,
  verifyStepUp,
} from "./auth.js";
import { loadConfig } from "./config.js";
import {
  conflict,
  forbidden,
  notFound,
  preconditionFailed,
  preconditionRequired,
  sendProblem,
  unauthorized,
} from "./errors.js";
import { requireOwner } from "./authz.js";
import { isMaintenanceActive } from "./maintenance.js";
import { sseHandler } from "./sse.js";

const APP_VERSION = "0.3.0";

/**
 * Honest agent flag for bootstrap (§7). The full OpenCode probe lives behind
 * GET /api/assistant/status (async, may bill); bootstrap only reports whether
 * the assistant can run: sidecar URL present AND ai.enabled not explicitly
 * off. Detailed connected/model/vision come from the assistant status route.
 */
function honestAgentForBootstrap(
  db: { prepare(sql: string): { get(...args: unknown[]): unknown } },
  cfg: { opencodeUrl: string | null },
): { enabled: boolean; connected: boolean } {
  if (!cfg.opencodeUrl) {
    return { enabled: false, connected: false };
  }
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ? AND deleted_at IS NULL")
      .get("ai.enabled") as { value: string } | undefined;
    if (row) {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (parsed === false) {
          return { enabled: false, connected: false };
        }
      } catch {
        // Non-JSON legacy value: treat "false"/"0" as off.
        if (row.value === "false" || row.value === "0") {
          return { enabled: false, connected: false };
        }
      }
    }
  } catch {
    // Settings read is best-effort; fall through to enabled.
  }
  return { enabled: true, connected: false };
}

/** Cookie name: __Host- prefix in secure contexts, plain fallback for http dev. */
export function sessionCookieName(): string {
  return loadConfig().isSecureCookies
    ? SESSION_COOKIE
    : "reminders_session";
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  const cfg = loadConfig();
  reply.setCookie(sessionCookieName(), token, {
    path: "/",
    httpOnly: true,
    secure: cfg.isSecureCookies,
    sameSite: "strict",
    maxAge: cfg.sessionIdleSeconds,
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  const cfg = loadConfig();
  const opts = {
    path: "/",
    httpOnly: true,
    secure: cfg.isSecureCookies,
    sameSite: "strict" as const,
  };
  // Clear both names: the active one plus any stale counterpart from a
  // previous secure/dev mode switch.
  reply.clearCookie(sessionCookieName(), opts);
  reply.clearCookie(SESSION_COOKIE, { ...opts, secure: true });
  reply.clearCookie("reminders_session", { ...opts, secure: false });
}

// ---------------------------------------------------------------------------
// If-Match / ETag (§5 concurrency) — M1 task/list mutations use this.
// ---------------------------------------------------------------------------

/**
 * Enforce `If-Match: "rev-N"` against currentRev.
 * Returns true when the caller may proceed; otherwise sends 428 (missing)
 * or 412 (stale) and returns false.
 */
export function requireIfMatch(
  req: FastifyRequest,
  reply: FastifyReply,
  currentRev: number,
): boolean {
  const raw = req.headers["if-match"];
  if (raw === undefined) {
    preconditionRequired(req, reply);
    return false;
  }
  const want = parseIfMatch(raw);
  if (want === null || want !== currentRev) {
    reply.header("ETag", etagForRev(currentRev));
    preconditionFailed(req, reply, currentRev);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Idempotency-Key + operations table replay (§5)
// ---------------------------------------------------------------------------

function idempotencyKey(req: FastifyRequest): string | null {
  const v = req.headers["idempotency-key"];
  if (typeof v !== "string" || v.trim() === "") return null;
  if (v.length > 128) return null;
  return v.trim();
}

function sha256Json(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface OperationRow {
  op_id: string;
  result_json: string;
}

function lookupOperation(opId: string): OperationRow | null {
  try {
    const row = getDb()
      .prepare("SELECT op_id, result_json FROM operations WHERE op_id = ?")
      .get(opId) as OperationRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function storeOperation(opts: {
  opId: string;
  kind: string;
  entityId: string | null;
  baseRev: number | null;
  payloadHash: string | null;
  result: unknown;
}): void {
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO operations
           (op_id, kind, entity_id, base_rev, payload_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.opId,
        opts.kind,
        opts.entityId,
        opts.baseRev,
        opts.payloadHash,
        JSON.stringify(opts.result),
        nowIso(),
      );
  } catch {
    // Idempotency persistence is best-effort; the mutation already committed.
  }
}

// ---------------------------------------------------------------------------
// Login rate limiting: per IP + per account (§8)
// ---------------------------------------------------------------------------

interface Bucket {
  count: number;
  resetAt: number;
}
const loginBuckets = new Map<string, Bucket>();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_PER_ACCOUNT = 10;
const LOGIN_MAX_PER_IP = 30;

function hitBucket(key: string, max: number): boolean {
  const now = Date.now();
  if (loginBuckets.size > 10_000) {
    for (const [entryKey, bucket] of loginBuckets) {
      if (bucket.resetAt <= now) loginBuckets.delete(entryKey);
    }
  }
  const b = loginBuckets.get(key);
  if (!b || b.resetAt <= now) {
    loginBuckets.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  b.count += 1;
  return b.count <= max;
}

function loginAllowed(ip: string, account: string): boolean {
  return (
    hitBucket(`ip:${ip}`, LOGIN_MAX_PER_IP) &&
    hitBucket(`acct:${ip}|${account.toLowerCase()}`, LOGIN_MAX_PER_ACCOUNT)
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function publicUser(u: {
  id: string;
  username: string;
  role: string;
  timezone: string;
  created_at: string;
}) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    timezone: u.timezone,
    createdAt: u.created_at,
  };
}

function currentMaxRev(): number {
  const db = getDb();
  try {
    const l = db
      .prepare("SELECT MAX(rev) AS m FROM lists WHERE deleted_at IS NULL")
      .get() as { m: number | null };
    const t = db
      .prepare("SELECT MAX(rev) AS m FROM tasks WHERE deleted_at IS NULL")
      .get() as { m: number | null };
    return Math.max(l.m ?? 0, t.m ?? 0, 0);
  } catch {
    return 0;
  }
}

function currentCursor(): number {
  try {
    const row = getDb()
      .prepare("SELECT MAX(seq) AS m FROM activity")
      .get() as { m: number | null };
    return row.m ?? 0;
  } catch {
    return 0;
  }
}

function readSettings(): Record<string, unknown> {
  try {
    const rows = getDb()
      .prepare("SELECT key, value FROM settings")
      .all() as Array<{ key: string; value: string }>;
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        out[r.key] = r.value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Workspace-global settings are owner-only reads too (Round 3). Members still
 * get their per-user preferences; ntfy/digest/provider/backup/MCP configuration
 * and reset advisories stay visible only to the owner. Writes were already
 * owner-gated in PATCH /api/settings.
 */
const OWNER_ONLY_SETTING_KEYS = new Set([
  "ntfy",
  "digest",
  "backup",
  "agent",
  "login_reset_required",
  "push_resubscribe_required",
]);

function settingsForUser(
  settings: Record<string, unknown>,
  owner: boolean,
): Record<string, unknown> {
  if (owner) return settings;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (OWNER_ONLY_SETTING_KEYS.has(key)) continue;
    if (key.startsWith("ai.") || key.startsWith("mcp.")) continue;
    if (key.startsWith("vapid")) continue;
    out[key] = value;
  }
  return out;
}

function visibleSettings(owner: boolean): Record<string, unknown> {
  return settingsForUser(stripSecretSettings(readSettings()), owner);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ---- liveness (no auth, no DB) -----------------------------------------
  app.get("/healthz", async (_req, reply) => {
    return reply
      .header("cache-control", "no-store")
      .send({ status: "ok", version: APP_VERSION, time: nowIso() });
  });

  // ---- readiness (internal: gate via Caddy / READYZ_TOKEN) ----------------
  app.get("/readyz", async (req, reply) => {
    const cfg = loadConfig();
    if (cfg.readyzToken) {
      const got = req.headers["x-readyz-token"];
      const want = cfg.readyzToken;
      const ok =
        typeof got === "string" &&
        got.length === want.length &&
        crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
      if (!ok) {
        return unauthorized(req, reply, "forbidden", "Readiness probe forbidden.");
      }
    }
    if (isMaintenanceActive()) {
      return reply
        .code(503)
        .header("cache-control", "no-store")
        .header("retry-after", "5")
        .send({
          status: "maintenance",
          checks: { db: "maintenance", scheduler: "maintenance" },
          schema: null,
          time: nowIso(),
        });
    }
    const checks: Record<string, string> = {};
    let dbOk = false;
    let schema: {
      applied: number | null;
      bundled: number | null;
      pending: number;
      newer: boolean;
    } | null = null;
    try {
      const row = getDb().prepare("SELECT 1 AS ok").get() as { ok: number };
      dbOk = row?.ok === 1;
      checks["db"] = dbOk ? "ok" : "fail";
    } catch {
      checks["db"] = "fail";
    }
    try {
      const status = migrationStatus(getDb());
      schema = {
        applied: status.applied,
        bundled: status.bundled,
        pending: status.pending,
        newer: status.newer,
      };
      checks["schema"] = status.newer
        ? "newer"
        : status.pending > 0
          ? `pending-${status.pending}`
          : "ok";
    } catch {
      checks["schema"] = "fail";
    }
    try {
      const s = getDb()
        .prepare("SELECT lease_until FROM scheduler_state WHERE id = 1")
        .get() as { lease_until: string | null } | undefined;
      checks["scheduler"] = s ? "ok" : "empty";
    } catch {
      checks["scheduler"] = "fail";
    }
    if (!cfg.opencodeUrl) {
      checks["opencode"] = "disabled";
    } else {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 2000);
        try {
          // The sidecar requires Basic auth (OPENCODE_PASSWORD). Without it
          // the probe reports http-401 and looks broken; authenticate like
          // the harness does (`curl -u opencode:$PASSWORD`).
          const password = process.env["OPENCODE_PASSWORD"]?.trim() || "";
          const headers: Record<string, string> = {};
          if (password) {
            headers["authorization"] =
              "Basic " +
              Buffer.from(`opencode:${password}`).toString("base64");
          }
          const res = await fetch(`${cfg.opencodeUrl}/api/info`, {
            signal: ctl.signal,
            headers,
          });
          checks["opencode"] = res.ok ? "ok" : `http-${res.status}`;
        } finally {
          clearTimeout(t);
        }
      } catch {
        checks["opencode"] = "unreachable";
      }
    }
    // OpenCode is optional (AI-off is first-class): only DB gates readiness.
    if (!dbOk) {
      return reply
        .code(503)
        .header("cache-control", "no-store")
        .send({ status: "down", checks, schema, time: nowIso() });
    }
    return reply
      .header("cache-control", "no-store")
      .send({ status: "ready", checks, schema, time: nowIso() });
  });

  // ---- diagnostics (owner-only, redacted; plan §5) -------------------------
  app.get("/api/diagnostics", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return reply;
    const cfg = loadConfig();
    const db = getDb();
    let lastBackup: Record<string, unknown> | null = null;
    try {
      lastBackup = db
        .prepare(
          "SELECT id, path, bytes, schema_version, status, created_at FROM backup_runs ORDER BY created_at DESC LIMIT 1",
        )
        .get() as Record<string, unknown> | undefined ?? null;
      if (lastBackup && typeof lastBackup["path"] === "string") {
        // Redact to basename — never leak absolute volume paths.
        const p = lastBackup["path"] as string;
        lastBackup = { ...lastBackup, path: p.split("/").pop() };
      }
    } catch {
      lastBackup = null;
    }
    let scheduler: Record<string, unknown> | null = null;
    try {
      scheduler = db
        .prepare(
          "SELECT last_tick_at, last_catchup_at, lease_owner, lease_until FROM scheduler_state WHERE id = 1",
        )
        .get() as Record<string, unknown> | undefined ?? null;
      if (scheduler) {
        // Lease owner is internal; expose presence only.
        const { lease_owner: _drop, ...rest } = scheduler;
        scheduler = rest;
      }
    } catch {
      scheduler = null;
    }
    return reply
      .header("cache-control", "no-store")
      .send({
        version: APP_VERSION,
        node: process.version,
        time: nowIso(),
        maxRev: currentMaxRev(),
        cursor: currentCursor(),
        scheduler,
        lastBackup,
        agent: { enabled: Boolean(cfg.opencodeUrl), connected: undefined },
      });
  });

  // ---- GET /api/setup/status ----------------------------------------------
  // Public on purpose: the SPA uses it to decide between first-run setup and
  // sign-in before any session exists. It exposes only booleans.
  app.get("/api/setup/status", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return {
      setupRequired: countUsers() === 0,
      tokenRequired: loadConfig().setupMode === "token",
    };
  });

  // ---- POST /api/setup ----------------------------------------------------
  // Strict route-level guard on top of the in-handler token check: the
  // invalid-token path costs one dummy Argon2id hash (timing uniformity),
  // so unauthenticated setup probing must be throttled before it burns CPU.
  app.post(
    "/api/setup",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "10 minutes" },
      },
    },
    async (req, reply) => {
    const parsed = setupRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendProblem(req, reply, 400, "Bad Request", {
        detail: "Invalid setup request (token, password ≥12 chars).",
        code: "invalid_request",
      });
    }
    // Idempotency-Key replay first (safe result only — no secrets stored),
    // so a retried setup after a dropped response replays 201, not 409.
    const opKey = idempotencyKey(req);
    if (opKey) {
      const prior = lookupOperation(`setup:${opKey}`);
      if (prior) {
        try {
          return reply
            .code(201)
            .header("idempotent-replayed", "true")
            .send(JSON.parse(prior.result_json));
        } catch {
          // fall through to normal handling
        }
      }
    }
    // Atomic first-user guard: 409 after setup regardless of token validity
    // (avoids a setup-token oracle post-provisioning).
    if (countUsers() > 0) {
      return conflict(req, reply, "setup_complete", "Setup already complete.");
    }
    const cfg = loadConfig();
    // Open first-run (default): the first visitor claims the owner account.
    // Token mode is the opt-in gate for internet-facing deployments.
    if (cfg.setupMode === "token") {
      const expected = cfg.setupToken;
      if (!expected) {
        return sendProblem(req, reply, 500, "Server Misconfigured", {
          detail: "Setup token is not configured.",
          code: "setup_misconfigured",
        });
      }
      if (!setupTokensEqual(parsed.data.token ?? "", expected)) {
        // Uniform delay: setup token failures cost one dummy hash so that
        // valid/invalid tokens are not distinguishable by timing.
        await verifyLoginPassword(null, "dummy");
        return forbidden(req, reply, "invalid_token", "Invalid setup token.");
      }
    }
    try {
      const { user, token } = await createFirstUserAtomic({
        password: parsed.data.password,
        timezone: parsed.data.timezone,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      setSessionCookie(reply, token);
      const result = { user: publicUser(user) };
      if (opKey) {
        storeOperation({
          opId: `setup:${opKey}`,
          kind: "setup",
          entityId: user.id,
          baseRev: null,
          payloadHash: sha256Json({ tz: parsed.data.timezone ?? null }),
          result,
        });
      }
      return reply.code(201).send(result);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "SETUP_DONE") {
        return conflict(req, reply, "setup_complete", "Setup already complete.");
      }
      throw err;
    }
    },
  );

  // ---- POST /api/login ----------------------------------------------------
  // Route-level IP guard complements the per-IP+account bucket below.
  app.post(
    "/api/login",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "10 minutes" },
      },
    },
    async (req, reply) => {
      const parsed = loginRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        // Uniform shape: do not reveal which field failed.
        return unauthorized(req, reply, "invalid_credentials", "Invalid credentials.");
      }
      const account = parsed.data.username ?? "owner";
      if (!loginAllowed(req.ip, account)) {
        reply.header("retry-after", "600");
        return sendProblem(req, reply, 429, "Too Many Requests", {
          detail: "Too many login attempts. Try again later.",
          code: "rate_limited",
        });
      }
      const user = getUserByUsername(account);
      const { ok, user: verified } = await verifyLoginPassword(
        user,
        parsed.data.password,
      );
      if (!ok || !verified) {
        return unauthorized(req, reply, "invalid_credentials", "Invalid credentials.");
      }
      // Rotate: drop the presenting session (if it belonged to this user),
      // then issue exactly one fresh token.
      const presenting = readSessionToken(req);
      if (presenting) {
        try {
          const old = getSessionByToken(presenting);
          if (old && old.user_id === verified.id) {
            revokeSession(old.id);
          }
        } catch {
          // ignore cleanup errors; login still proceeds
        }
      }
      const { token } = createSession(verified.id, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      setSessionCookie(reply, token);
      return reply.send({ user: publicUser(verified) });
    },
  );

  // ---- POST /api/logout ---------------------------------------------------
  app.post("/api/logout", async (req, reply) => {
    const raw = readSessionToken(req);
    if (raw) {
      const s = getSessionByToken(raw);
      if (s) revokeSession(s.id);
    }
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  // ---- GET /api/auth/session ----------------------------------------------
  app.get("/api/auth/session", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return reply.send({ authenticated: false });
    return reply.send({
      authenticated: true,
      user: publicUser(auth.user),
      session: {
        id: auth.session.id,
        createdAt: auth.session.created_at,
        expiresAt: auth.session.expires_at,
        stepUpAt: auth.session.step_up_at,
      },
    });
  });

  // ---- POST /api/auth/password (step-up) -----------------------------------
  // Strict route-level guard: every attempt costs an Argon2id verify, so
  // password guessing against a stolen cookie must be throttled here.
  app.post(
    "/api/auth/password",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "10 minutes" },
      },
    },
    async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    const parsed = stepUpRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return unauthorized(req, reply, "step_up_failed", "Step-up failed.");
    }
    const ok = await verifyStepUp(
      auth.user,
      auth.session.id,
      parsed.data.password,
    );
    if (!ok) {
      return unauthorized(req, reply, "step_up_failed", "Step-up failed.");
    }
    const fresh = getSessionByToken(readSessionToken(req) ?? "");
    return reply.send({ ok: true, stepUpAt: fresh?.step_up_at ?? nowIso() });
    },
  );

  // ---- POST /api/auth/change-password ---------------------------------------
  // In-app password change. The current password is the step-up proof; all
  // other sessions are revoked and the current one stays signed in.
  app.post(
    "/api/auth/change-password",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const auth = authenticateRequest(req);
      if (!auth) return unauthorized(req, reply);
      const body =
        req.body !== null && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : null;
      const currentPassword = body?.["currentPassword"];
      const newPassword = body?.["newPassword"];
      if (
        typeof currentPassword !== "string" ||
        typeof newPassword !== "string" ||
        currentPassword.length === 0 ||
        newPassword.length < 12 ||
        newPassword.length > 200
      ) {
        return sendProblem(req, reply, 400, "Bad Request", {
          detail:
            "currentPassword and a newPassword of 12–200 characters are required.",
          code: "invalid_request",
        });
      }
      const ok = await verifyPassword(
        auth.user.password_hash,
        currentPassword,
      );
      if (!ok) {
        return unauthorized(
          req,
          reply,
          "step_up_failed",
          "Current password did not match.",
        );
      }
      const passwordHash = await hashPassword(newPassword);
      const now = nowIso();
      const db = getDb();
      let revoked = 0;
      const tx = db.transaction(() => {
        db.prepare(
          "UPDATE users SET password_hash = ?, rev = rev + 1, updated_at = ? WHERE id = ?",
        ).run(passwordHash, now, auth.user.id);
        const info = db
          .prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?")
          .run(auth.user.id, auth.session.id);
        revoked = Number(info.changes);
        // Password change is a lockout action: persistent API credentials
        // must not outlive it.
        db.prepare(
          "UPDATE capture_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        ).run(now, auth.user.id);
      });
      tx();
      confirmStepUp(auth.session.id);
      return reply.send({ ok: true, revokedSessions: revoked });
    },
  );

  // ---- PATCH /api/me --------------------------------------------------------
  // Per-account preferences. Timezone is deliberately member-writable: it is
  // the fallback zone for this user's own reminders and shared-list quiet
  // hours, not the workspace-wide default.
  app.patch(
    "/api/me",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const auth = authenticateRequest(req);
      if (!auth) return unauthorized(req, reply);
      const body =
        req.body !== null && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : null;
      const timezone = body?.["timezone"];
      if (typeof timezone !== "string" || !isValidTimeZone(timezone)) {
        return sendProblem(req, reply, 400, "Bad Request", {
          detail: "A valid IANA timezone is required.",
          code: "invalid_timezone",
        });
      }
      const now = nowIso();
      getDb()
        .prepare(
          "UPDATE users SET timezone = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .run(timezone, now, auth.user.id);
      return reply.send({
        user: publicUser({ ...auth.user, timezone }),
      });
    },
  );

  // ---- GET /api/auth/sessions ----------------------------------------------
  app.get("/api/auth/sessions", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    const sessions = listSessions(auth.user.id).map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      ip: s.ip,
      userAgent: s.user_agent,
      current: s.id === auth.session.id,
    }));
    return reply.send({ sessions });
  });

  // ---- DELETE /api/auth/sessions/:id ----------------------------------------
  app.delete("/api/auth/sessions/:id", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    const id = (req.params as { id?: string })?.id;
    if (!id || typeof id !== "string" || id.length > 64) {
      return notFound(req, reply);
    }
    const target = listSessions(auth.user.id).find((s) => s.id === id);
    if (!target) return notFound(req, reply);
    if (id !== auth.session.id && !isStepUpFresh(auth.session)) {
      return forbidden(req, reply, "step_up_required", "Confirm your password first.");
    }
    revokeSession(id);
    if (id === auth.session.id) clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  // ---- GET /api/users (owner-only, multi-account, no secrets) --------------
  app.get("/api/users", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return reply;
    return reply.send({
      users: listUsers().map((user) => ({
        id: user.id,
        username: user.username,
        role: user.role,
        timezone: user.timezone,
        createdAt: user.created_at,
        current: user.id === auth.user.id,
      })),
    });
  });

  // ---- POST /api/users (additional account; step-up required) ----------------
  app.post(
    "/api/users",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (req, reply) => {
      const auth = requireOwner(req, reply);
      if (!auth) return reply;
      if (!isStepUpFresh(auth.session)) {
        return forbidden(
          req,
          reply,
          "step_up_required",
          "Confirm your password first.",
        );
      }
      const body =
        req.body !== null && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : null;
      const username =
        typeof body?.["username"] === "string"
          ? body["username"].trim().toLowerCase()
          : "";
      const password =
        typeof body?.["password"] === "string" ? body["password"] : "";
      const timezone =
        typeof body?.["timezone"] === "string" ? body["timezone"] : "UTC";
      if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(username)) {
        return sendProblem(req, reply, 400, "Bad Request", {
          detail:
            "username must be 2–64 lowercase letters, numbers, dots, underscores, or hyphens.",
          code: "invalid_username",
        });
      }
      if (password.length < 12 || password.length > 200) {
        return sendProblem(req, reply, 400, "Bad Request", {
          detail: "password must be 12–200 characters.",
          code: "invalid_password",
        });
      }
      if (!isValidTimeZone(timezone)) {
        return sendProblem(req, reply, 400, "Bad Request", {
          detail: "Unknown timezone.",
          code: "invalid_timezone",
        });
      }
      if (getUserByUsername(username)) {
        return conflict(req, reply, "username_exists", "That username is taken.");
      }
      try {
        const user = await createUser({ username, password, timezone });
        return reply.code(201).send({
          user: publicUser(user),
          note: "This account has its own private lists and tasks.",
        });
      } catch {
        return conflict(req, reply, "username_exists", "That username is taken.");
      }
    },
  );

  // ---- GET /api/bootstrap ----------------------------------------------------
  app.get("/api/bootstrap", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    const cfg = loadConfig();
    const db = getDb();
    let lists: Array<Record<string, unknown>> = [];
    let tasks: Array<Record<string, unknown>> = [];
    let tags: Array<Record<string, unknown>> = [];
    let taskTags: Array<Record<string, unknown>> = [];
    try {
      lists = db
        .prepare(
          `SELECT l.*,
                  CASE WHEN l.user_id = ? THEN 0 ELSE 1 END AS shared,
                  owner.username AS owner_username
             FROM lists l
             JOIN users owner ON owner.id = l.user_id
            WHERE l.deleted_at IS NULL
              AND (l.user_id = ? OR EXISTS (
                SELECT 1 FROM list_members lm
                 WHERE lm.list_id = l.id AND lm.user_id = ?
              ))
            ORDER BY shared ASC, l.created_at ASC`,
        )
        .all(auth.user.id, auth.user.id, auth.user.id) as Array<
        Record<string, unknown>
      >;
    } catch {
      lists = [];
    }
    try {
      tasks = db
        .prepare(
          `SELECT t.* FROM tasks t
            WHERE (${TASK_ACCESS_SQL}) AND t.deleted_at IS NULL
            ORDER BY t.created_at ASC LIMIT 5000`,
        )
        .all(auth.user.id, auth.user.id, auth.user.id) as Array<
          Record<string, unknown>
        >;
    } catch {
      tasks = [];
    }
    try {
      tags = db
        .prepare(
          `SELECT tg.*,
                  (SELECT COUNT(*) FROM task_tags tt
                     JOIN tasks t ON t.id = tt.task_id
                    WHERE tt.tag_id = tg.id AND t.deleted_at IS NULL
                      AND t.status = 'open') AS open_count
             FROM tags tg
            WHERE tg.user_id = ? AND tg.deleted_at IS NULL
            ORDER BY lower(tg.name) ASC, tg.id ASC`,
        )
        .all(auth.user.id) as Array<Record<string, unknown>>;
    } catch {
      tags = [];
    }
    try {
      taskTags = db
        .prepare(
          `SELECT tt.task_id, tt.tag_id FROM task_tags tt
             JOIN tasks t ON t.id = tt.task_id
             JOIN tags tg ON tg.id = tt.tag_id
            WHERE (${TASK_ACCESS_SQL}) AND t.deleted_at IS NULL
              AND tg.deleted_at IS NULL AND tg.user_id = ?`,
        )
        .all(auth.user.id, auth.user.id, auth.user.id, auth.user.id) as Array<
        Record<string, unknown>
      >;
    } catch {
      taskTags = [];
    }
    // Ensure a default list exists for fresh installs (M1 owns full CRUD).
    // Seeded BEFORE revision computation so ETag/cursor reflect it.
    if (lists.length === 0) {
      const now = nowIso();
      const id = newId();
      try {
        db.prepare(
          `INSERT INTO lists (id, user_id, name, rev, created_at, updated_at)
           VALUES (?, ?, 'Inbox', 1, ?, ?)`,
        ).run(id, auth.user.id, now, now);
        lists = db
          .prepare("SELECT * FROM lists WHERE id = ?")
          .all(id) as Array<Record<string, unknown>>;
      } catch {
        // ignore; M1 owns list seeding policy
      }
    }
    const maxRev = currentMaxRev();
    const cursor = currentCursor();
    reply.header("ETag", etagForRev(maxRev));
    return reply.send({
      user: publicUser(auth.user),
      // Secret-like keys (mcp.tokens.v1, vapid_private_key, …) must never
      // leave the server. Members additionally do not receive workspace-global
      // notification/admin settings (Round 3).
      settings: visibleSettings(isOwner(auth.user)),
      lists,
      tasks,
      tags,
      taskTags,
      serverTime: nowIso(),
      maxRev,
      cursor,
      vapidPublicKey: cfg.vapidPublicKey,
      agent: honestAgentForBootstrap(db, cfg),
    });
  });

  // ---- GET /api/events (SSE stub; M2 full) -----------------------------------
  app.get("/api/events", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) {
      return unauthorized(req, reply);
    }
    await sseHandler(req, reply, { userId: auth.user.id });
  });

  // M3-BACKUP-BEGIN (M3 backup/trust: export/import/restore, activity/undo,
  // task ledger, trash, settings. Plan §3 backup format + §5 routes + §8
  // restore security + §9 ledger one-liner. No scheduler/push/assistant/M1
  // logic is touched here — this block only appends routes.)
  function m3db(): BackupDb {
    return getDb() as unknown as BackupDb;
  }

  function m3audit(input: RecordActivityInput): void {
    try {
      recordActivity(getDb() as unknown as ActivityDb, input);
    } catch {
      // Audit is best-effort; never fail the mutation it describes.
    }
  }

  function m3problem(req: FastifyRequest, reply: FastifyReply, err: unknown) {
    if (err instanceof BackupVerificationError) {
      const tooBig = err.errors.some((e) => e.includes("exceeds"));
      return sendProblem(
        req,
        reply,
        tooBig ? 413 : 400,
        tooBig ? "Payload Too Large" : "Bad Request",
        {
          detail: err.errors.join("; "),
          code: tooBig ? "backup_too_large" : "invalid_backup",
        },
      );
    }
    if (err instanceof RestoreError || err instanceof ActivityError) {
      if (err.status === 503) reply.header("retry-after", "5");
      const title =
        err.status === 404
          ? "Not Found"
          : err.status === 409
            ? "Conflict"
            : err.status === 403
              ? "Forbidden"
              : err.status === 428
                ? "Precondition Required"
                : err.status === 503
                  ? "Service Unavailable"
                  : "Bad Request";
      return sendProblem(req, reply, err.status, title, {
        detail: err.message,
        code: err.code,
      });
    }
    throw err;
  }

  // ---- GET /api/backup/export (JSON download) ------------------------------
  // Bulk data leaves the server here: require a fresh step-up on top of auth
  // (§8), and throttle so exports cannot be used to pin disk/CPU.
  app.get(
    "/api/backup/export",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return reply;
    if (!isStepUpFresh(auth.session)) {
      return forbidden(
        req,
        reply,
        "step_up_required",
        "Confirm your password first.",
      );
    }
    const result = await exportBackup(m3db(), { status: "manual" });
    const body = Buffer.from(result.bytes);
    if (result.age?.enabled) {
      reply.header("x-backup-age", "age");
      reply.header("x-backup-age-recipient", result.age.recipient ?? "");
    }
    return reply
      .header(
        "content-type",
        result.encrypted ? "application/octet-stream" : "application/json",
      )
      .header("content-disposition", `attachment; filename="${result.name}"`)
      .header("x-backup-sha256", result.sha256)
      .send(body);
    },
  );

  // ---- POST /api/backup/run (nightly manual snapshot + retention) -----------
  app.post(
    "/api/backup/run",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return reply;
    if (!isStepUpFresh(auth.session)) {
      return forbidden(
        req,
        reply,
        "step_up_required",
        "Confirm your password first.",
      );
    }
    const { run, pruned } = await runBackupNow(m3db(), { status: "nightly" });
    return reply.send({
      run: {
        id: run.id,
        name: run.name,
        sha256: run.sha256,
        bytes: run.bytes,
        schemaVersion: run.schemaVersion,
        createdAt: run.createdAt,
        status: run.status,
        downloadUrl: `/api/backup/download/${run.id}`,
      },
      pruned: pruned.map((p) => ({ id: p.id, path: p.path })),
    });
    },
  );

  // ---- GET /api/backup/runs (ledger) -----------------------------------------
  app.get("/api/backup/runs", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return reply;
    const runs = listBackupRuns(m3db());
    return reply.send({
      runs: runs.map((r) => ({
        id: r.id,
        name: r.name,
        sha256: r.sha256,
        bytes: r.bytes,
        schemaVersion: r.schemaVersion,
        createdAt: r.createdAt,
        status: r.status,
        fileExists: r.fileExists,
        downloadUrl: `/api/backup/download/${r.id}`,
      })),
    });
  });

  // ---- GET /api/backup/download/:id -------------------------------------------
  app.get(
    "/api/backup/download/:id",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return reply;
    if (!isStepUpFresh(auth.session)) {
      return forbidden(
        req,
        reply,
        "step_up_required",
        "Confirm your password first.",
      );
    }
    const id = (req.params as { id?: string })?.id ?? "";
    let file: { entry: { name: string; sha256: string }; bytes: Buffer };
    try {
      file = readBackupRunFile(m3db(), id);
    } catch (err) {
      return m3problem(req, reply, err);
    }
    const encrypted = file.entry.name.endsWith(".age");
    return reply
      .header(
        "content-type",
        encrypted ? "application/octet-stream" : "application/json",
      )
      .header("content-disposition", `attachment; filename="${file.entry.name}"`)
      .header("x-backup-sha256", file.entry.sha256)
      .send(file.bytes);
    },
  );

  // ---- POST /api/backup/import?dryRun=1 (multipart, step-up, typed confirm) ---
  app.post(
    "/api/backup/import",
    {
      bodyLimit: resolveBackupMaxBytes() + 1024 * 1024,
      config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
    },
    async (req, reply) => {
      const auth = requireOwner(req, reply);
      if (!auth) return reply;
      if (!isStepUpFresh(auth.session)) {
        return forbidden(
          req,
          reply,
          "step_up_required",
          "Confirm your password first.",
        );
      }
      const contentType = String(req.headers["content-type"] ?? "");
      if (!contentType.includes("multipart/form-data")) {
        return sendProblem(req, reply, 400, "Bad Request", {
          detail:
            "Send multipart/form-data with the backup in field 'backup' (and 'confirm' when applying).",
          code: "multipart_required",
        });
      }
      let fileBytes: Buffer | null = null;
      let fileTruncated = false;
      let confirm: unknown;
      try {
        for await (const part of req.parts()) {
          if (part.type === "file") {
            if (part.fieldname !== "backup" || fileBytes) {
              part.file.resume();
              continue;
            }
            fileBytes = await part.toBuffer();
            fileTruncated =
              (part.file as unknown as { truncated?: boolean }).truncated ===
              true;
          } else if (part.type === "field" && part.fieldname === "confirm") {
            confirm = part.value;
          }
        }
      } catch (err) {
        return m3problem(req, reply, err);
      }
      if (!fileBytes) {
        return sendProblem(req, reply, 400, "Bad Request", {
          detail: "Multipart field 'backup' is required.",
          code: "missing_backup",
        });
      }
      const maxBackupBytes = resolveBackupMaxBytes();
      if (fileTruncated || fileBytes.byteLength > maxBackupBytes) {
        return sendProblem(req, reply, 413, "Payload Too Large", {
          detail: `Backup exceeds the ${maxBackupBytes} byte upload cap.`,
          code: "backup_too_large",
        });
      }
      const query = req.query as { dryRun?: string } | undefined;
      const dryRun = query?.dryRun === "1" || query?.dryRun === "true";
      let document;
      try {
        document = await verifyUploadBackupAsync(fileBytes);
      } catch (err) {
        return m3problem(req, reply, err);
      }
      if (dryRun) {
        const live = readLiveBackupData();
        const diff = computeRestoreDiff(live, document.data);
        return reply.send({
          dryRun: true,
          sha256: document.sha256,
          exportedAt: document.exportedAt,
          schemaVersion: document.schemaVersion,
          bytes: fileBytes.byteLength,
          counts: {
            lists: document.data.lists.length,
            tasks: document.data.tasks.length,
            taskCompletions: document.data.taskCompletions.length,
            settings: Object.keys(document.data.settings).length,
            conversations: document.data.conversations.length,
            activity: document.data.activity.length,
          },
          diff,
        });
      }
      try {
        assertRestoreConfirm({ confirm });
      } catch (err) {
        return m3problem(req, reply, err);
      }
      try {
        const outcome = await restoreDatabaseFromBackup(
          resolveDatabasePath(),
          fileBytes,
          { actor: "user", actorId: auth.user.id },
        );
        return reply.send({ dryRun: false, ...outcome });
      } catch (err) {
        return m3problem(req, reply, err);
      }
    },
  );

  // ---- GET/PATCH /api/settings (non-secret settings only) ----------------------
  app.get("/api/settings", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    return reply.send({ settings: visibleSettings(isOwner(auth.user)) });
  });

  app.patch("/api/settings", async (req, reply) => {
    const auth = requireOwner(req, reply);
    if (!auth) return reply;
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendProblem(req, reply, 400, "Bad Request", {
        detail: "Settings body must be a JSON object.",
        code: "invalid_settings",
      });
    }
    // MCP-adjacent keys (mcp.tokens.v1, mcp.enabled, …) gate server-side
    // privileged channels: touching them needs a fresh step-up, exactly like
    // the dedicated /api/mcp admin routes. Plain preference keys stay
    // auth-only so every theme toggle does not cost a password prompt.
    const touchesMcp = Object.keys(body).some(
      (key) => key === "mcp" || key.startsWith("mcp."),
    );
    if (touchesMcp && !isStepUpFresh(auth.session)) {
      return forbidden(
        req,
        reply,
        "step_up_required",
        "Confirm your password first.",
      );
    }
    for (const [key, value] of Object.entries(body)) {
      if (key.length === 0 || key.length > 128) {
        return sendProblem(req, reply, 400, "Bad Request", {
          detail: `Invalid settings key: ${key.slice(0, 32)}.`,
          code: "invalid_settings",
        });
      }
      if (isSecretLikeKey(key)) {
        return sendProblem(req, reply, 400, "Bad Request", {
          detail: `Settings key "${key}" looks secret and cannot be set here.`,
          code: "secret_setting_rejected",
        });
      }
      let encoded: string;
      try {
        encoded = typeof value === "string" ? value : JSON.stringify(value);
        if (encoded === undefined) throw new Error("unserializable");
      } catch {
        return sendProblem(req, reply, 400, "Bad Request", {
          detail: `Settings value for "${key}" is not JSON-serializable.`,
          code: "invalid_settings",
        });
      }
      if (encoded.length > 100_000) {
        return sendProblem(req, reply, 400, "Bad Request", {
          detail: `Settings value for "${key}" is too large.`,
          code: "invalid_settings",
        });
      }
    }
    const db = getDb();
    const now = nowIso();
    const tx = db.transaction(() => {
      for (const [key, value] of Object.entries(body)) {
        const encoded = typeof value === "string" ? value : JSON.stringify(value);
        db.prepare(
          `INSERT INTO settings (key, value, rev, updated_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, rev = rev + 1, updated_at = excluded.updated_at`,
        ).run(key, encoded, now);
      }
    });
    tx();
    m3audit({
      actor: "user",
      actorId: auth.user.id,
      action: "settings.update",
      entityType: "settings",
      entityId: "settings",
      summary: `Updated ${Object.keys(body).length} setting(s)`,
    });
    return reply.send({ settings: stripSecretSettings(readSettings()) });
  });

  // ---- GET /api/activity (seq cursor for SSE replay) ------------------------------
  app.get("/api/activity", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    const query = req.query as
      | { cursor?: string; limit?: string; order?: string }
      | undefined;
    const order = query?.order === "desc" ? "desc" : "asc";
    const cursor =
      query?.cursor === undefined ? undefined : Number(query.cursor);
    const limit = query?.limit === undefined ? 200 : Number(query.limit);
    if (
      cursor !== undefined &&
      (!Number.isSafeInteger(cursor) || cursor < 0)
    ) {
      return sendProblem(req, reply, 400, "Bad Request", {
        detail: "cursor must be a non-negative integer seq.",
        code: "invalid_cursor",
      });
    }
    const { rows, cursor: next } = listActivity(m3db(), {
      cursor,
      limit: Number.isSafeInteger(limit) ? limit : 200,
      order,
      // Members see only their own actions. Owner sees the workspace feed.
      ...(isOwner(auth.user) ? {} : { actorId: auth.user.id }),
    });
    return reply.send({
      activities: rows.map((r) => activityToJson(r)),
      cursor: next,
    });
  });

  // ---- POST /api/activity/:id/undo (single-op revert) ------------------------------
  app.post("/api/activity/:id/undo", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    const raw = (req.params as { id?: string })?.id ?? "";
    const seq = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      return sendProblem(req, reply, 400, "Bad Request", {
        detail: "Activity id must be a positive integer seq.",
        code: "invalid_activity_id",
      });
    }
    const activityRow = getActivity(m3db(), seq);
    if (!isOwner(auth.user)) {
      // Direct-seq authorization, not just list filtering: a member can undo
      // only an action they performed on a task/list they can still access.
      // A mismatch is a 404 so the row's existence is not disclosed.
      if (!activityRow || activityRow.actor_id !== auth.user.id) {
        return notFound(req, reply);
      }
      const entityType = activityRow.entity_type?.toLowerCase() ?? "";
      const entityId = activityRow.entity_id ?? "";
      const accessible =
        entityType === "task" || entityType === "tasks"
          ? Boolean(entityId) &&
            canAccessTask(auth.user.id, entityId, { includeDeleted: true })
          : entityType === "list" || entityType === "lists"
            ? Boolean(entityId) &&
              canAccessList(auth.user.id, entityId, { includeDeleted: true })
            : false;
      if (!accessible) return notFound(req, reply);
    }
    try {
      const result = undoActivity(m3db(), seq, {
        actor: "user",
        actorId: auth.user.id,
      });
      return reply.send({
        undone: result.undoneSeq,
        activitySeq: result.seq,
        entityType: result.entityType,
        entityId: result.entityId,
      });
    } catch (err) {
      return m3problem(req, reply, err);
    }
  });

  // ---- GET /api/tasks/:id/ledger (§9 one-liner backing data) -------------------------
  app.get("/api/tasks/:id/ledger", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    const id = (req.params as { id?: string })?.id ?? "";
    if (!id || id.length > 64) return notFound(req, reply);
    const db = getDb();
    const task = db
      .prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?")
      .get(id, auth.user.id) as Record<string, unknown> | undefined;
    if (!task) return notFound(req, reply);
    const devices = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM push_subscriptions
           WHERE user_id = ? AND enabled = 1 AND deleted_at IS NULL`,
        )
        .get(auth.user.id) as { n: number }
    ).n;
    const last = db
      .prepare(
        `SELECT status, last_status, sent_at, created_at FROM deliveries
         WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(id) as
      | {
          status: string;
          last_status: string | null;
          sent_at: string | null;
          created_at: string;
        }
      | undefined;
    return reply.send({
      taskId: id,
      next_occurrence_at: task["next_occurrence_at"] ?? null,
      next_occurrence_local: task["next_occurrence_local"] ?? null,
      devices,
      last_sent: last?.sent_at ?? null,
      last_status: last?.last_status ?? last?.status ?? null,
    });
  });

  // ---- GET /api/trash (Recently Deleted, §9) -------------------------------------------
  app.get("/api/trash", async (req, reply) => {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    const db = getDb();
    const tasks = db
      .prepare(
        "SELECT * FROM tasks WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY updated_at DESC LIMIT 200",
      )
      .all(auth.user.id);
    const lists = db
      .prepare(
        "SELECT * FROM lists WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY updated_at DESC LIMIT 200",
      )
      .all(auth.user.id);
    return reply.send({ tasks, lists });
  });

  function m3restoreFromTrash(
    req: FastifyRequest,
    reply: FastifyReply,
    table: "tasks" | "lists",
  ) {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    const id = (req.params as { id?: string })?.id ?? "";
    if (!id || id.length > 64) return notFound(req, reply);
    const db = getDb();
    const before = db
      .prepare(`SELECT * FROM "${table}" WHERE id = ? AND user_id = ?`)
      .get(id, auth.user.id) as Record<string, unknown> | undefined;
    if (!before) return notFound(req, reply);
    if (before["deleted_at"] == null) {
      return conflict(req, reply, "not_deleted", "Item is not in trash.");
    }
    const now = nowIso();
    db.prepare(
      `UPDATE "${table}" SET deleted_at = NULL, rev = rev + 1, updated_at = ? WHERE id = ?`,
    ).run(now, id);
    const after = db
      .prepare(`SELECT * FROM "${table}" WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    m3audit({
      actor: "user",
      actorId: auth.user.id,
      action: table === "tasks" ? "task.restore" : "list.restore",
      entityType: table === "tasks" ? "task" : "list",
      entityId: id,
      before,
      after,
      summary: `Restored ${table === "tasks" ? "task" : "list"} from trash`,
    });
    return reply.send({ ok: true, [table === "tasks" ? "task" : "list"]: after });
  }

  function m3purgeFromTrash(
    req: FastifyRequest,
    reply: FastifyReply,
    table: "tasks" | "lists",
  ) {
    const auth = authenticateRequest(req);
    if (!auth) return unauthorized(req, reply);
    if (!isStepUpFresh(auth.session)) {
      return forbidden(
        req,
        reply,
        "step_up_required",
        "Confirm your password first.",
      );
    }
    const id = (req.params as { id?: string })?.id ?? "";
    if (!id || id.length > 64) return notFound(req, reply);
    const db = getDb();
    const before = db
      .prepare(`SELECT * FROM "${table}" WHERE id = ? AND user_id = ?`)
      .get(id, auth.user.id) as Record<string, unknown> | undefined;
    if (!before) return notFound(req, reply);
    if (before["deleted_at"] == null) {
      return conflict(
        req,
        reply,
        "not_deleted",
        "Only trashed items can be purged. Delete it first.",
      );
    }
    // List purge nulls out member tasks via FK `ON DELETE SET NULL`.
    // The audit row is written in the same transaction: undo relies on it to
    // prove the item was permanently deleted and must never be resurrected.
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
      recordActivity(db as unknown as ActivityDb, {
        actor: "user",
        actorId: auth.user.id,
        action: table === "tasks" ? "task.purge" : "list.purge",
        entityType: table === "tasks" ? "task" : "list",
        entityId: id,
        before,
        after: null,
        summary: `Permanently deleted ${table === "tasks" ? "task" : "list"} from trash`,
      });
    });
    tx();
    return reply.send({ ok: true });
  }

  // ---- Trash restore (auth) / purge (auth + step-up) -------------------------------------
  // Restore stays auth-only BY DECISION (not by omission): it is fully
  // reversible (re-delete or purge), writes an audited activity row with
  // before/after snapshots, moves no bulk data off the server, and touches
  // only rows the caller already owns. Destructive purge keeps step-up.
  app.post("/api/trash/tasks/:id/restore", async (req, reply) =>
    m3restoreFromTrash(req, reply, "tasks"),
  );
  app.post("/api/trash/lists/:id/restore", async (req, reply) =>
    m3restoreFromTrash(req, reply, "lists"),
  );
  app.delete("/api/trash/tasks/:id", async (req, reply) =>
    m3purgeFromTrash(req, reply, "tasks"),
  );
  app.delete("/api/trash/lists/:id", async (req, reply) =>
    m3purgeFromTrash(req, reply, "lists"),
  );
  // M3-BACKUP-END

  // ---- 404 → problem+json (with SPA fallback for client routes) -----------
  app.setNotFoundHandler((req, reply) => {
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      !req.url.startsWith("/api/") &&
      req.url !== "/healthz" &&
      req.url !== "/readyz"
    ) {
      const accept = String(req.headers["accept"] ?? "");
      if (accept.includes("text/html") || !accept.includes("application/")) {
        // First-run routing happens before the SPA boots: a fresh instance
        // must never show a sign-in or "session expired" screen. These are
        // document requests only, so asset/API traffic is untouched.
        const pathname = (req.url.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
        let users = 0;
        try {
          users = countUsers();
        } catch {
          // DB not ready: fall through to the SPA and let it report.
        }
        if (accept.includes("text/html")) {
          if (users === 0 && pathname !== "/setup") {
            return reply.code(302).header("location", "/setup").send();
          }
          if (users > 0 && pathname === "/setup") {
            return reply.code(302).header("location", "/login").send();
          }
        }
        // Serve PWA index.html for client routes (/today, /login, ...).
        const here = path.dirname(fileURLToPath(import.meta.url));
        const candidates = [
          path.resolve(here, "..", "..", "..", "web", "dist", "index.html"),
          path.resolve(process.cwd(), "apps", "web", "dist", "index.html"),
        ];
        for (const p of candidates) {
          try {
            if (fs.existsSync(p)) {
              return reply.type("text/html").send(fs.readFileSync(p));
            }
          } catch {
            // fall through to problem+json
          }
        }
      }
    }
    return sendProblem(req, reply, 404, "Not Found", {
      detail: `No route for ${req.method} ${req.url}.`,
      code: "not_found",
    });
  });

  // M1-TASKS-BEGIN — lists/tasks/search/capture (M1). M0/M2/M3 routes above untouched.
  // Dynamic imports keep this block purely additive: no new top-level imports,
  // no changes to setup/auth/bootstrap/SSE wiring.
  {
    const { registerListRoutes } = await import("./lists.js");
    const { registerTaskRoutes } = await import("./tasks.js");
    const { registerSearchRoutes } = await import("./search.js");
    const { registerCaptureRoutes } = await import("./captureParse.js");
    await registerListRoutes(app);
    await registerTaskRoutes(app);
    await registerSearchRoutes(app);
    await registerCaptureRoutes(app);
  }
  // M1-TASKS-END

  // M4.1-PROVIDERS-BEGIN — provider credential management (API keys only).
  // Self-contained append: routesProviders.ts owns validation, key storage,
  // overlay rendering, SSRF probes, and audit; no M0–M4 logic above changes.
  {
    const { registerProviderRoutes } = await import("./routesProviders.js");
    await registerProviderRoutes(app);
  }
  // M4.1-PROVIDERS-END
}

// M2-PUSH-BEGIN
// Push routes are implemented in routesPush.ts and registered by index.ts.
// This marker keeps the M1/M3 route blocks above untouched.
export { registerPushRoutes } from "./routesPush.js";
// M2-PUSH-END
