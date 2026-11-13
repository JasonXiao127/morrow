/**
 * CLI reset-password transport tests (§8): stdin is the safe path, argv stays
 * supported (with a ps warning), and every reset revokes all sessions.
 */
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb, initSchema } from "@morrow/db";
import { hashPassword, verifyPassword } from "../src/auth.js";
import { resetConfigCache } from "../src/config.js";
import { runResetPassword } from "../src/reset-password.js";

const USER_ID = "01900000-0000-7000-8000-000000000001";
const SESSION_ID = "01900000-0000-7000-8000-000000000009";
const MEMBER_ID = "01900000-0000-7000-8000-000000000002";
const MEMBER_SESSION_ID = "01900000-0000-7000-8000-00000000000a";
const ARGV_PASSWORD = "argv-reset-password-01";
const STDIN_PASSWORD = "stdin-reset-password-02";

let dir = "";
const savedEnv: Record<string, string | undefined> = {};

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  let text = "";
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      text +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, text: () => text };
}

function seedUserAndSession(hash: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO users
       (id, username, password_hash, timezone, rev, created_at, updated_at)
     VALUES (?, 'owner', ?, 'UTC', 1, ?, ?)`,
  ).run(USER_ID, hash, now, now);
  db.prepare(
    `INSERT OR REPLACE INTO sessions
       (id, user_id, token_hash, created_at, last_seen_at, expires_at, absolute_expires_at)
     VALUES (?, ?, 'session-token-hash', ?, ?, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`,
  ).run(SESSION_ID, USER_ID, now, now);
}

function seedMember(hash: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO users
       (id, username, password_hash, role, timezone, rev, created_at, updated_at)
     VALUES (?, 'member', ?, 'member', 'UTC', 1, ?, ?)`,
  ).run(MEMBER_ID, hash, now, now);
  db.prepare(
    `INSERT OR REPLACE INTO sessions
       (id, user_id, token_hash, created_at, last_seen_at, expires_at, absolute_expires_at)
     VALUES (?, ?, 'member-session-token-hash', ?, ?, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`,
  ).run(MEMBER_SESSION_ID, MEMBER_ID, now, now);
}

function hashFor(userId: string): string {
  return (
    getDb()
      .prepare("SELECT password_hash FROM users WHERE id = ?")
      .get(userId) as { password_hash: string }
  ).password_hash;
}

function sessionCountFor(userId: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
      .get(userId) as { n: number }
  ).n;
}

function userHash(): string {
  return (
    getDb()
      .prepare("SELECT password_hash FROM users WHERE id = ?")
      .get(USER_ID) as { password_hash: string }
  ).password_hash;
}

function sessionCount(): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
      .get(USER_ID) as { n: number }
  ).n;
}

beforeAll(async () => {
  for (const k of ["DATABASE_PATH", "SECRETS_DIR", "APP_URL"]) {
    savedEnv[k] = process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "morrow-reset-password-"));
  process.env["DATABASE_PATH"] = join(dir, "morrow.db");
  process.env["SECRETS_DIR"] = join(dir, "secrets");
  process.env["APP_URL"] = "http://localhost:3000";
  resetConfigCache();
  closeDb();
  initSchema(getDb());
  seedUserAndSession(await hashPassword("old-password-12345"));
});

afterAll(() => {
  closeDb();
  resetConfigCache();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("reset-password CLI transports", () => {
  it("reads the password from stdin when the argument is '-'", async () => {
    const stdout = sink();
    const stderr = sink();
    const code = await runResetPassword(["-"], {
      stdin: Readable.from([`${STDIN_PASSWORD}\n`]),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stdout.text()).toContain("password reset for owner;");
    expect(stderr.text()).not.toContain("visible in ps");
    expect(await verifyPassword(userHash(), STDIN_PASSWORD)).toBe(true);
    expect(sessionCount()).toBe(0);
  });

  it("keeps argv working but warns that ps can see it", async () => {
    seedUserAndSession(await hashPassword("old-password-12345"));
    const stdout = sink();
    const stderr = sink();
    const code = await runResetPassword([ARGV_PASSWORD], {
      stdin: Readable.from([]),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.text()).toContain("visible in ps");
    expect(stdout.text()).toContain("password reset for owner;");
    expect(await verifyPassword(userHash(), ARGV_PASSWORD)).toBe(true);
    expect(sessionCount()).toBe(0);
  });

  it("resets only the named account (default stays owner)", async () => {
    seedUserAndSession(await hashPassword("owner-old-password-01"));
    seedMember(await hashPassword("member-old-password-01"));
    const ownerBefore = userHash();

    const stdout = sink();
    const code = await runResetPassword(
      ["--user", "member", "member-new-password-02"],
      {
        stdin: Readable.from([]),
        stdout: stdout.stream,
        stderr: sink().stream,
      },
    );

    expect(code).toBe(0);
    expect(stdout.text()).toContain("password reset for member;");
    expect(await verifyPassword(hashFor(MEMBER_ID), "member-new-password-02")).toBe(
      true,
    );
    expect(await verifyPassword(ownerBefore, "owner-old-password-01")).toBe(true);
    expect(hashFor(USER_ID)).toBe(ownerBefore);
    expect(sessionCountFor(MEMBER_ID)).toBe(0);
    // The owner's session is untouched.
    expect(sessionCountFor(USER_ID)).toBe(1);
  });

  it("rejects an empty stdin password without touching the hash", async () => {
    seedUserAndSession(await hashPassword("old-password-12345"));
    const before = userHash();
    const stderr = sink();
    const code = await runResetPassword(["-"], {
      stdin: Readable.from(["\n"]),
      stdout: sink().stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(2);
    expect(stderr.text()).toContain("usage:");
    expect(userHash()).toBe(before);
  });
});
