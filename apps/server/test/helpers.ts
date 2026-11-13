import { openDatabase } from "@morrow/db";
import type { ActivityDb } from "../src/activity.js";
import type { BackupDb } from "../src/backup.js";

export const SEED_NOW = "2026-11-02T12:00:00.000Z";
export const SEED_USER_ID = "01900000-0000-7000-8000-000000000001";
export const SEED_LIST_ID = "01900000-0000-7000-8000-000000000002";
export const SEED_TASK_ID = "01900000-0000-7000-8000-000000000003";

export function memBackupDb() {
  const { sqlite, close } = openDatabase({ path: ":memory:" });
  return { db: sqlite as unknown as BackupDb, close };
}

export function memActivityDb() {
  const { sqlite, close } = openDatabase({ path: ":memory:" });
  return { db: sqlite as unknown as ActivityDb, raw: sqlite, close };
}

/**
 * Seed a :memory: DB with allowlisted rows PLUS secret-bearing rows that
 * must never appear in an export (password hash, session token hash, push
 * keys, private settings). Distinctive marker values make the canary grep
 * exact.
 */
export function seedSecretsDb(db: BackupDb): void {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, timezone, rev, created_at, updated_at)
     VALUES (?, 'owner', 'PW-HASH-SECRET-1', 'UTC', 1, ?, ?)`,
  ).run(SEED_USER_ID, SEED_NOW, SEED_NOW);
  db.prepare(
    `INSERT INTO lists (id, user_id, name, sort_key, is_inbox, rev, created_at, updated_at, deleted_at)
     VALUES ('01900000-0000-7000-8000-000000000002', ?, 'Inbox', 'V00000000000000', 1, 1, ?, ?, NULL)`,
  ).run(SEED_USER_ID, SEED_NOW, SEED_NOW);
  db.prepare(
    `INSERT INTO tasks (id, user_id, list_id, title, status, priority, all_day, recurrence_mode,
       clamp_policy, occurrence_seq, missed_count, sort_key, rev, created_at, updated_at, deleted_at)
     VALUES ('01900000-0000-7000-8000-000000000003', ?, '01900000-0000-7000-8000-000000000002',
       'Milk', 'open', 0, 0, 'schedule', 'skip', 0, 0, 'V00000000000000', 1, ?, ?, NULL)`,
  ).run(SEED_USER_ID, SEED_NOW, SEED_NOW);
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, absolute_expires_at)
     VALUES ('01900000-0000-7000-8000-000000000009', ?, 'SESS-TOKEN-SECRET-2', ?, ?, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`,
  ).run(SEED_USER_ID, SEED_NOW, SEED_NOW);
  db.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, endpoint_hash, p256dh, auth, rev, created_at, updated_at)
     VALUES ('01900000-0000-7000-8000-00000000000a', ?, 'https://push.example/ENDPOINT-SECRET-6',
       'ENDPOINT-SECRET-6', 'P256DH-SECRET-3', 'AUTH-SECRET-4', 1, ?, ?)`,
  ).run(SEED_USER_ID, SEED_NOW, SEED_NOW);
  db.prepare(
    `INSERT INTO settings (key, value, rev, updated_at) VALUES
       ('timezone', ?, 1, ?),
       ('agent', ?, 1, ?),
       ('vapid_private_key', ?, 1, ?)`,
  ).run(
    JSON.stringify("America/New_York"),
    SEED_NOW,
    JSON.stringify({ model: "x" }),
    SEED_NOW,
    JSON.stringify("VAPID-PRIV-SECRET-5"),
    SEED_NOW,
  );
}
