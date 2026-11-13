/**
 * Auth: setup token, Argon2id, sessions, CSRF, step-up (§8).
 *
 * - Setup token: SECRETS_DIR/setup_token (0600) or SETUP_TOKEN env; atomic
 *   first-user insert; 409 after; token file deleted on success.
 * - Argon2id: 64 MiB / t=3 / p=1 (exceeds the ≥19 MiB, t≥2, p=1 floor).
 *   Unique salt per hash (argon2 default); rehash on login when params stale.
 * - Session cookie: `__Host-reminders_session; Secure; HttpOnly;
 *   SameSite=Strict; Path=/`. 256-bit token, SHA-256 hex at rest, rotated on
 *   login/reset. 7-day idle + 30-day absolute expiry.
 * - CSRF: unsafe /api* methods require Origin match or Sec-Fetch-Site
 *   same-origin when those headers are present (browsers always send one);
 *   bare non-browser clients (curl) with neither header are allowed through.
 * - Uniform login errors + dummy Argon2 verify to avoid user enumeration.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { hash, verify } from "@node-rs/argon2";
import type { FastifyRequest } from "fastify";
import { getDb } from "@morrow/db";
import { newId, nowIso } from "@morrow/shared";
import { loadConfig } from "./config.js";

export const SESSION_COOKIE = "__Host-reminders_session";

// Argon2id parameters: 64 MiB / t=3 / p=1 (floor: 19 MiB / t=2 / p=1).
const ARGON_MEMORY_KIB = 65536;
const ARGON_TIME = 3;
const ARGON_PARALLELISM = 1;

export type UserRole = "owner" | "member";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  timezone: string;
  created_at: string;
  updated_at: string;
}

/** True only for the workspace owner; legacy rows backfilled at startup. */
export function isOwner(user: { role?: string | null }): boolean {
  return user.role === "owner";
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  absolute_expires_at: string;
  step_up_at: string | null;
  ip: string | null;
  user_agent: string | null;
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    // 2 === Algorithm.Argon2id (numeric literal: @node-rs/argon2 declares
    // Algorithm as an ambient const enum, unusable with isolatedModules).
    algorithm: 2,
    memoryCost: ARGON_MEMORY_KIB,
    timeCost: ARGON_TIME,
    parallelism: ARGON_PARALLELISM,
  });
}

export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

/** True when the stored PHC string uses weaker params than current policy. */
export function hashNeedsRehash(storedHash: string): boolean {
  const m = /\$m=(\d+),t=(\d+),p=(\d+)/.exec(storedHash);
  if (!m) return true;
  const mem = Number.parseInt(m[1] ?? "0", 10);
  const t = Number.parseInt(m[2] ?? "0", 10);
  const p = Number.parseInt(m[3] ?? "0", 10);
  return mem < ARGON_MEMORY_KIB || t < ARGON_TIME || p !== ARGON_PARALLELISM;
}

// Dummy hash for uniform-timing login failures (user-not-found path).
let dummyHash: string | null = null;

/** Precompute the dummy hash at boot so login timing stays uniform. */
export async function initAuth(): Promise<void> {
  if (dummyHash) return;
  dummyHash = await hashPassword(
    `dummy:${crypto.randomBytes(16).toString("hex")}`,
  );
}

async function dummyVerify(): Promise<void> {
  try {
    if (!dummyHash) {
      dummyHash = await hashPassword(
        `dummy:${crypto.randomBytes(16).toString("hex")}`,
      );
    }
    await verify(dummyHash, "dummy-wrong-password");
  } catch {
    // Timing only; ignore result.
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/** Dev-only fallback cookie name for http://localhost (no Secure). */
export const DEV_SESSION_COOKIE = "reminders_session";

/** Read the session token from either the __Host- or dev cookie. */
export function readSessionToken(req: FastifyRequest): string | null {
  const cookies = (req.cookies as Record<string, string | undefined>) ?? {};
  return cookies[SESSION_COOKIE] ?? cookies[DEV_SESSION_COOKIE] ?? null;
}

/** 256-bit session token, base64url. */
export function newSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Constant-time setup-token comparison (length-mixed safe). */
export function setupTokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still do a compare to keep timing roughly uniform.
    const n = Math.max(ab.length, bb.length);
    const xa = Buffer.alloc(n, 0);
    const xb = Buffer.alloc(n, 1);
    ab.copy(xa);
    bb.copy(xb);
    crypto.timingSafeEqual(xa, xb);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export function countUsers(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS n FROM users").get() as {
    n: number;
  };
  return row.n;
}

/**
 * Backfill/repair the workspace owner after migrations and restores.
 * The migration promotes the earliest legacy user; this also covers databases
 * created before roles existed whose migration ran while the users table was
 * empty, and a restore that recreated users without a role.
 */
export function ensureOwnerRole(): void {
  const db = getDb();
  const hasOwner = db
    .prepare(
      "SELECT 1 AS found FROM users WHERE role = 'owner' AND deleted_at IS NULL LIMIT 1",
    )
    .get() as { found: number } | undefined;
  if (hasOwner) return;
  db.prepare(
    `UPDATE users
        SET role = 'owner'
      WHERE deleted_at IS NULL
        AND id = (
          SELECT id FROM users
           WHERE deleted_at IS NULL
           ORDER BY created_at ASC, id ASC LIMIT 1
        )`,
  ).run();
}

export function getUserById(id: string): UserRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL")
    .get(id) as UserRow | undefined;
  return row ?? null;
}

/** Single-user lookup: the earliest-created live user (legacy setup path). */
export function getSingleUser(): UserRow | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .get() as UserRow | undefined;
  return row ?? null;
}

export function getUserByUsername(username: string): UserRow | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM users WHERE lower(username) = lower(?) AND deleted_at IS NULL",
    )
    .get(username) as UserRow | undefined;
  return row ?? null;
}

export function listUsers(): Array<
  Pick<
    UserRow,
    "id" | "username" | "role" | "timezone" | "created_at" | "updated_at"
  >
> {
  return getDb()
    .prepare(
      `SELECT id, username, role, timezone, created_at, updated_at
         FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC`,
    )
    .all() as Array<
    Pick<
      UserRow,
      "id" | "username" | "role" | "timezone" | "created_at" | "updated_at"
    >
  >;
}

/** Create an additional independent account (no shared lists yet). */
export async function createUser(opts: {
  username: string;
  password: string;
  timezone?: string;
}): Promise<UserRow> {
  const passwordHash = await hashPassword(opts.password);
  const now = nowIso();
  const id = newId();
  const db = getDb();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, timezone, created_at, updated_at)
     VALUES (?, ?, ?, 'member', ?, ?, ?)`,
  ).run(
    id,
    opts.username,
    passwordHash,
    opts.timezone ?? "UTC",
    now,
    now,
  );
  const user = getUserById(id);
  if (!user) throw new Error("user insert failed");
  return user;
}

/**
 * Atomic first-user insert (§8: 409 after). Creates user + initial session
 * inside one IMMEDIATE transaction; returns the new user + raw session token.
 * Throws { code: 'SETUP_DONE' } when a user already exists.
 */
export async function createFirstUserAtomic(opts: {
  password: string;
  timezone?: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ user: UserRow; token: string; sessionId: string }> {
  const cfg = loadConfig();
  const passwordHash = await hashPassword(opts.password);
  const now = nowIso();
  const userId = newId();
  const token = newSessionToken();
  const tokenHash = sha256Hex(token);
  const sessionId = newId();
  const idleMs = cfg.sessionIdleSeconds * 1000;
  const absMs = cfg.sessionAbsoluteSeconds * 1000;

  const db = getDb();
  const tx = db.transaction(() => {
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }
    ).n;
    if (n > 0) {
      const err = new Error("setup already complete") as Error & {
        code: string;
      };
      err.code = "SETUP_DONE";
      throw err;
    }
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, timezone, created_at, updated_at)
       VALUES (?, 'owner', ?, 'owner', ?, ?, ?)`,
    ).run(userId, passwordHash, opts.timezone ?? "UTC", now, now);
    db.prepare(
      `INSERT INTO sessions
        (id, user_id, token_hash, created_at, last_seen_at, expires_at, absolute_expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      userId,
      tokenHash,
      now,
      now,
      new Date(Date.now() + idleMs).toISOString(),
      new Date(Date.now() + absMs).toISOString(),
      opts.ip ?? null,
      opts.userAgent ?? null,
    );
  });
  tx();

  const user = getUserById(userId);
  if (!user) throw new Error("first-user insert failed");
  deleteSetupTokenFile();
  return { user, token, sessionId };
}

/** Best-effort setup-token file deletion after first user (ignore ENOENT). */
export function deleteSetupTokenFile(): void {
  try {
    const cfg = loadConfig();
    fs.unlinkSync(cfg.setupTokenFile);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function createSession(
  userId: string,
  opts: { ip?: string; userAgent?: string } = {},
): { token: string; session: SessionRow } {
  const cfg = loadConfig();
  const db = getDb();
  const now = nowIso();
  const token = newSessionToken();
  const session: SessionRow = {
    id: newId(),
    user_id: userId,
    token_hash: sha256Hex(token),
    created_at: now,
    last_seen_at: now,
    expires_at: new Date(Date.now() + cfg.sessionIdleSeconds * 1000).toISOString(),
    absolute_expires_at: new Date(
      Date.now() + cfg.sessionAbsoluteSeconds * 1000,
    ).toISOString(),
    step_up_at: null,
    ip: opts.ip ?? null,
    user_agent: opts.userAgent ?? null,
  };
  db.prepare(
    `INSERT INTO sessions
      (id, user_id, token_hash, created_at, last_seen_at, expires_at, absolute_expires_at, step_up_at, ip, user_agent)
     VALUES (@id, @user_id, @token_hash, @created_at, @last_seen_at, @expires_at, @absolute_expires_at, @step_up_at, @ip, @user_agent)`,
  ).run(session);
  return { token, session };
}

export function getSessionByToken(rawToken: string): SessionRow | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM sessions WHERE token_hash = ?")
    .get(sha256Hex(rawToken)) as SessionRow | undefined;
  return row ?? null;
}

function isExpired(s: SessionRow, nowMs = Date.now()): boolean {
  return (
    Date.parse(s.expires_at) <= nowMs ||
    Date.parse(s.absolute_expires_at) <= nowMs
  );
}

/**
 * Validate the request's session cookie. Returns { user, session } or null.
 * Refreshes idle expiry (rolling 7d) when more than half the idle window
 * has elapsed; absolute expiry never extends.
 */
export function authenticateRequest(req: FastifyRequest): {
  user: UserRow;
  session: SessionRow;
} | null {
  const raw = readSessionToken(req);
  if (!raw) return null;
  const session = getSessionByToken(raw);
  if (!session) return null;
  if (isExpired(session)) {
    try {
      getDb().prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    } catch {
      // ignore cleanup errors
    }
    return null;
  }
  const user = getUserById(session.user_id);
  if (!user) return null;
  // Rolling idle refresh (extend expires_at, capped by absolute_expires_at).
  try {
    const cfg = loadConfig();
    const remaining = Date.parse(session.expires_at) - Date.now();
    if (remaining < (cfg.sessionIdleSeconds * 1000) / 2) {
      const next = new Date(
        Date.now() + cfg.sessionIdleSeconds * 1000,
      ).toISOString();
      const capped =
        next > session.absolute_expires_at
          ? session.absolute_expires_at
          : next;
      getDb()
        .prepare(
          "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?",
        )
        .run(nowIso(), capped, session.id);
      session.last_seen_at = nowIso();
      session.expires_at = capped;
    } else {
      getDb()
        .prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
        .run(nowIso(), session.id);
    }
  } catch {
    // Non-fatal; session remains valid.
  }
  return { user, session };
}

/** Rotate: delete current token row, issue a fresh token (login/reset). */
export function rotateSession(
  oldSessionId: string,
  userId: string,
  opts: { ip?: string; userAgent?: string } = {},
): { token: string; session: SessionRow } {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE id = ?").run(oldSessionId);
  return createSession(userId, opts);
}

export function revokeSession(sessionId: string): boolean {
  const info = getDb()
    .prepare("DELETE FROM sessions WHERE id = ?")
    .run(sessionId);
  return info.changes > 0;
}

export function revokeAllSessions(userId: string): number {
  const info = getDb()
    .prepare("DELETE FROM sessions WHERE user_id = ?")
    .run(userId);
  return Number(info.changes);
}

export function listSessions(userId: string): Array<
  Omit<SessionRow, "token_hash">
> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, user_id, created_at, last_seen_at, expires_at,
              absolute_expires_at, step_up_at, ip, user_agent
       FROM sessions WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId) as Array<Omit<SessionRow, "token_hash">>;
  return rows;
}

// ---------------------------------------------------------------------------
// Step-up (§8: restore, password change, MCP rotation, session revoke)
// ---------------------------------------------------------------------------

export function confirmStepUp(sessionId: string): void {
  getDb()
    .prepare("UPDATE sessions SET step_up_at = ? WHERE id = ?")
    .run(nowIso(), sessionId);
}

export function isStepUpFresh(session: SessionRow): boolean {
  if (!session.step_up_at) return false;
  const cfg = loadConfig();
  return Date.now() - Date.parse(session.step_up_at) <= cfg.stepUpSeconds * 1000;
}

/** Verify password for step-up; on success stamps step_up_at. Uniform false. */
export async function verifyStepUp(
  user: UserRow,
  sessionId: string,
  password: string,
): Promise<boolean> {
  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) return false;
  confirmStepUp(sessionId);
  return true;
}

// ---------------------------------------------------------------------------
// CSRF (§8)
// ---------------------------------------------------------------------------

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Return true when the request passes CSRF checks.
 *
 * Browsers always send Origin and/or Sec-Fetch-Site on fetch. A browser-set
 * `Sec-Fetch-Site: same-origin` is sufficient proof that the request came from
 * this very origin, so it must pass even when APP_URL names another address
 * (LAN IP, alternate hostname, reverse proxy). Origin may also match APP_URL.
 * Non-browser clients (curl) sending neither header are allowed through.
 *
 * Nothing here may trust a header the attacker controls as a *browser* would:
 * a cross-site page cannot set Sec-Fetch-Site, and a forged Origin is rejected.
 */
export function passesCsrf(req: FastifyRequest, appUrl: string): boolean {
  if (!UNSAFE.has(req.method)) return true;
  const origin = req.headers.origin;
  const sfs = req.headers["sec-fetch-site"];
  if (!origin && !sfs) return true; // curl / service client

  const sameOrigin = typeof sfs === "string" && sfs.toLowerCase() === "same-origin";
  if (sameOrigin) return true;

  if (typeof origin === "string" && origin !== "") {
    try {
      if (origin === new URL(appUrl).origin) return true;
    } catch {
      return false;
    }
    return false;
  }

  // An Origin-less request with a non-same-origin Sec-Fetch-Site (cross-site,
  // same-site, none) is not an allowed browser mutation.
  return typeof sfs !== "string" || sfs === "";
}

// ---------------------------------------------------------------------------
// Login (uniform errors + dummy hash + rehash)
// ---------------------------------------------------------------------------

export async function verifyLoginPassword(
  user: UserRow | null,
  password: string,
): Promise<{ ok: boolean; user: UserRow | null }> {
  if (!user) {
    await dummyVerify();
    return { ok: false, user: null };
  }
  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) return { ok: false, user: null };
  if (hashNeedsRehash(user.password_hash)) {
    try {
      const fresh = await hashPassword(password);
      getDb()
        .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(fresh, nowIso(), user.id);
      user.password_hash = fresh;
    } catch {
      // Rehash failure is non-fatal.
    }
  }
  return { ok: true, user };
}

// ---------------------------------------------------------------------------
// CLI password reset (§8)
// ---------------------------------------------------------------------------

/** Reset the single user's password; revoke all sessions. Returns users reset. */
export async function resetPassword(newPassword: string): Promise<number> {
  const db = getDb();
  const users = db.prepare("SELECT * FROM users").all() as UserRow[];
  if (users.length === 0) return 0;
  const hashed = await hashPassword(newPassword);
  const now = nowIso();
  const tx = db.transaction(() => {
    for (const u of users) {
      db.prepare(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
      ).run(hashed, now, u.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
    }
  });
  tx();
  return users.length;
}
