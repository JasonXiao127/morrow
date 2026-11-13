/**
 * Restore flow (M3, plan §3 backup format + §8 backup/restore security).
 *
 * Pipeline for a live restore:
 *   1. Verify the upload (exact-byte SHA-256 + optional HMAC, 25MB cap,
 *      JSON depth/node/string caps) — backup.ts `verifyUploadBackup`.
 *   2. `dryRun` preview: diff backup vs live ({added, updated, deleted,
 *      conflicts}) without touching the DB.
 *   3. Typed confirm (`confirm === "RESTORE"`) + fresh step-up (route layer).
 *   4. Always write a pre-restore backup first (status `pre-restore`).
 *   5. Copy the live DB file to a temp DB, apply + migrate there,
 *      `integrity_check` + `foreign_key_check` inside the transaction,
 *      clear leases/`sending` deliveries, revoke sessions.
 *   6. Atomically swap the temp file over live, drop `-wal`/`-shm`,
 *      reopen, and re-verify integrity on the live handle.
 *
 * Password hashes and push keys are deliberately absent from backups, so a
 * live restore sets `login_reset_required` + `push_resubscribe_required`
 * settings flags and revokes every session (re-login everywhere).
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  closeDb,
  databaseIntegrity,
  getDb,
  openDatabase,
  setDatabaseReopenBlocked,
} from "@morrow/db";
import { newId, nowIso } from "@morrow/shared";
import {
  applyBackupDocument,
  exportBackup,
  readBackupDataSnapshot,
  resolveBackupDir,
  verifyUploadBackupAsync,
  type BackupData,
  type BackupDb,
  type BackupDocument,
  type BackupTableKey,
} from "./backup.js";
import { recordActivity } from "./activity.js";
import { invalidateCalDavSync } from "./caldavSync.js";
import { ensureOwnerRole } from "./auth.js";
import { rebindAssistant } from "./assistant.js";
import { beginMaintenance, endMaintenance, waitForActiveWrites } from "./maintenance.js";
import { restartMcpServerAfterRestore, stopMcpServer } from "./mcp.js";
import {
  restartSchedulerAfterRestore,
  stopScheduler,
  waitForSchedulerIdle,
} from "./scheduler.js";
import { invalidateSseClients } from "./sse.js";

export const RESTORE_CONFIRM_STRING = "RESTORE";

export class RestoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.name = "RestoreError";
    this.status = status;
    this.code = code;
  }
}

/** Typed-confirm gate (§8): the body must carry `confirm: "RESTORE"`. */
export function assertRestoreConfirm(body: unknown): void {
  const confirm =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)["confirm"]
      : undefined;
  if (confirm !== RESTORE_CONFIRM_STRING) {
    throw new RestoreError(
      400,
      "typed_confirm_required",
      `Restore requires { "confirm": "${RESTORE_CONFIRM_STRING}" }. A pre-restore backup is written first, but this still replaces current tasks.`,
    );
  }
}

// ---------------------------------------------------------------------------
// dryRun diff
// ---------------------------------------------------------------------------

export interface TableDiff {
  added: string[];
  updated: string[];
  deleted: string[];
}

export interface SettingsDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface RestoreConflict {
  table: BackupTableKey;
  id: string;
  liveUpdatedAt: string | null;
  incomingUpdatedAt: string | null;
}

export interface RestoreDiff {
  tables: Record<BackupTableKey, TableDiff>;
  settings: SettingsDiff;
  totals: { added: number; updated: number; deleted: number };
  conflicts: RestoreConflict[];
}

function rowKey(table: BackupTableKey, row: Record<string, unknown>): string {
  if (table === "activity") return String(row["seq"] ?? "");
  const id = row["id"];
  return typeof id === "string" ? id : JSON.stringify(row);
}

/** Key-sorted canonical form so column order never counts as a change. */
function canonRow(row: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) sorted[key] = row[key];
  return JSON.stringify(sorted);
}

function updatedAtOf(row: Record<string, unknown>): string | null {
  const v = row["updated_at"];
  return typeof v === "string" ? v : null;
}

/**
 * Preview what a restore would do. `live` = current DB data, `incoming` =
 * the verified backup. `conflicts` flags rows the live DB changed *after*
 * the backup's copy (restoring would overwrite newer data).
 */
export function computeRestoreDiff(
  live: BackupData,
  incoming: BackupData,
): RestoreDiff {
  const tables = {} as Record<BackupTableKey, TableDiff>;
  const conflicts: RestoreConflict[] = [];
  let added = 0;
  let updated = 0;
  let deleted = 0;

  for (const table of [
    "lists",
    "listMembers",
    "tags",
    "tasks",
    "taskTags",
    "subtasks",
    "taskCompletions",
    "conversations",
    "activity",
  ] as const) {
    const liveById = new Map<string, Record<string, unknown>>();
    for (const row of (live[table] ?? []) as Array<Record<string, unknown>>) {
      liveById.set(rowKey(table, row), row);
    }
    const incomingById = new Map<string, Record<string, unknown>>();
    for (const row of (incoming[table] ?? []) as Array<Record<string, unknown>>) {
      incomingById.set(rowKey(table, row), row);
    }
    const diff: TableDiff = { added: [], updated: [], deleted: [] };
    for (const [id, row] of incomingById) {
      const current = liveById.get(id);
      if (!current) {
        diff.added.push(id);
      } else if (canonRow(current) !== canonRow(row)) {
        diff.updated.push(id);
        const liveAt = updatedAtOf(current);
        const incomingAt = updatedAtOf(row);
        if (liveAt && incomingAt && liveAt > incomingAt) {
          conflicts.push({ table, id, liveUpdatedAt: liveAt, incomingUpdatedAt: incomingAt });
        }
      }
    }
    for (const id of liveById.keys()) {
      if (!incomingById.has(id)) diff.deleted.push(id);
    }
    diff.added.sort();
    diff.updated.sort();
    diff.deleted.sort();
    tables[table] = diff;
    added += diff.added.length;
    updated += diff.updated.length;
    deleted += diff.deleted.length;
  }

  const settings: SettingsDiff = { added: [], removed: [], changed: [] };
  const liveSettings = live.settings as Record<string, unknown>;
  const incomingSettings = incoming.settings as Record<string, unknown>;
  for (const key of Object.keys(incomingSettings).sort()) {
    if (!(key in liveSettings)) settings.added.push(key);
    else if (JSON.stringify(liveSettings[key]) !== JSON.stringify(incomingSettings[key])) {
      settings.changed.push(key);
    }
  }
  for (const key of Object.keys(liveSettings).sort()) {
    if (!(key in incomingSettings)) settings.removed.push(key);
  }

  conflicts.sort((a, b) =>
    a.table < b.table ? -1 : a.table > b.table ? 1 : a.id < b.id ? -1 : 1,
  );
  return { tables, settings, totals: { added, updated, deleted }, conflicts };
}

// ---------------------------------------------------------------------------
// Post-apply cleanup: leases, sending deliveries, sessions, reset flags
// ---------------------------------------------------------------------------

/** Clear scheduler leases + `sending` deliveries (at-least-once §4). */
export function clearDeliveryLeases(db: BackupDb): void {
  try {
    db.prepare(
      `UPDATE deliveries SET status = 'skipped', lease_until = NULL, claim_token = NULL WHERE status = 'sending'`,
    ).run();
  } catch {
    // deliveries may not exist on very old handles; non-fatal.
  }
  try {
    db.prepare(
      `UPDATE scheduler_state SET lease_owner = NULL, lease_until = NULL WHERE id = 1`,
    ).run();
  } catch {
    // scheduler_state is a singleton seeded by migrations; ignore if absent.
  }
}

/** Revoke every session (forces re-login everywhere after restore). */
export function revokeAllSessions(db: BackupDb): number {
  try {
    const info = db.prepare("DELETE FROM sessions").run();
    return Number(info.changes);
  } catch {
    return 0;
  }
}

/**
 * Restore invalidation for credentials that are deliberately outside the
 * backup payload. Capture and CalDAV tokens are bearer credentials; MCP tokens
 * live in a secret setting; proposals/operations can point at rows the restore
 * replaced. All of them must not survive a database rollback/snapshot swap.
 */
export function invalidateRestoredCredentials(db: BackupDb): void {
  for (const sql of [
    "DELETE FROM capture_tokens",
    "DELETE FROM proposals",
    "DELETE FROM operations",
    "DELETE FROM settings WHERE key = 'mcp.tokens.v1'",
  ]) {
    try {
      db.prepare(sql).run();
    } catch {
      // Older handles may lack a table; the rest of the invalidation continues.
    }
  }
  // Sync tokens must not survive a rollback/snapshot swap: the restored DB
  // may contain older task state, and a client that reused a token would miss
  // the difference. Rotating the epoch forces a full sync.
  invalidateCalDavSync(db);
}

function setSettingsFlag(db: BackupDb, key: string, value: unknown): void {
  const now = nowIso();
  try {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    db.prepare(
      "INSERT INTO settings (key, value, rev, updated_at) VALUES (?, ?, 1, ?)",
    ).run(key, JSON.stringify(value), now);
  } catch {
    // Flags are advisory; never fail a restore on them.
  }
}

export interface RestoreIntoDbOptions {
  actor?: string;
  actorId?: string | null;
  batchId?: string | null;
  /** Live-restore path sets the password/push advisory flags. */
  markResetRequired?: boolean;
}

export interface RestoreIntoDbResult {
  counts: Record<string, number>;
  sessionsRevoked: number;
}

/**
 * Apply a verified backup document to an OPEN handle (temp DB file in the
 * live flow, `:memory:`/temp file in tests): replace allowlisted tables
 * with integrity checks, clear leases, revoke sessions, write the audit row.
 */
export function restoreIntoDb(
  db: BackupDb,
  document: BackupDocument,
  options: RestoreIntoDbOptions = {},
): RestoreIntoDbResult {
  applyBackupDocument(db, document);
  const tx = db.transaction(() => {
    clearDeliveryLeases(db);
    const sessionsRevoked = revokeAllSessions(db);
    invalidateRestoredCredentials(db);
    if (options.markResetRequired) {
      // NOTE: the key deliberately avoids the substring "password" so it
      // passes the non-secret settings filter (SECRET_KEY_PATTERN) and the
      // UI can actually read it. Value set: { login_reset_required: true }.
      setSettingsFlag(db, "login_reset_required", true);
      setSettingsFlag(db, "push_resubscribe_required", true);
    }
    try {
      recordActivity(db, {
        batchId: options.batchId ?? newId(),
        actor: options.actor ?? "system",
        actorId: options.actorId ?? null,
        action: "backup.restore",
        entityType: "backup",
        entityId: document.sha256.slice(0, 16),
        before: null,
        after: {
          sha256: document.sha256,
          exportedAt: document.exportedAt,
          schemaVersion: document.schemaVersion,
        },
        summary: `Restored backup ${document.exportedAt} (${document.sha256.slice(0, 12)}…)`,
      });
    } catch {
      // Audit is best-effort; the restore already committed above.
    }
    return sessionsRevoked;
  });
  const sessionsRevoked = tx();
  return {
    counts: {
      lists: document.data.lists.length,
      listMembers: (document.data.listMembers ?? []).length,
      tags: (document.data.tags ?? []).length,
      tasks: document.data.tasks.length,
      taskTags: (document.data.taskTags ?? []).length,
      subtasks: (document.data.subtasks ?? []).length,
      taskCompletions: document.data.taskCompletions.length,
      settings: Object.keys(document.data.settings).length,
      conversations: document.data.conversations.length,
      activity: document.data.activity.length,
    },
    sessionsRevoked,
  };
}

// ---------------------------------------------------------------------------
// Live file-swap restore (temp DB → atomic replace)
// ---------------------------------------------------------------------------

export interface LiveRestoreOptions {
  backupDir?: string;
  actor?: string;
  actorId?: string | null;
  hmacKey?: string | Uint8Array;
  /**
   * Drill/test hook invoked after the maintenance gate is active and writers
   * are drained. Production does not set it; the restore-under-load test uses
   * it to prove mutating requests are refused while the swap is in progress.
   */
  onMaintenance?: () => void | Promise<void>;
}

export interface LiveRestoreResult {
  preRestore: { path: string; sha256: string; bytes: number };
  counts: Record<string, number>;
  sessionsRevoked: number;
  passwordResetRequired: boolean;
  pushResubscribeRequired: boolean;
  maintenance: { active: false; restarted: string[] };
}

function fsyncFile(filePath: string): void {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Durability best-effort; the rename is still atomic.
  }
}

function fsyncDirectory(dirPath: string): void {
  try {
    const fd = fs.openSync(dirPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Some platforms/filesystems cannot fsync a directory; ignore.
  }
}

function unlinkIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      // A stale sidecar that cannot be removed is fatal for the swap; let the
      // caller surface it rather than leaving WAL bytes next to a new DB.
      throw err;
    }
  }
}

/**
 * Full §3 drill with a process-wide maintenance window:
 * verify → gate/drain → pre-restore backup → checkpoint/close → temp-DB apply
 * (migrate + integrity/foreign-key checks) → fsync → atomic rename → reopen →
 * rebind scheduler/assistant/MCP → invalidate sessions/tokens/SSE cursors.
 *
 * The live file is never copied over in place: the already-verified temp DB is
 * renamed over it in one same-directory operation. `-wal`/`-shm` are removed
 * on both sides of the swap so SQLite cannot replay old WAL pages into the new
 * database. If anything fails before the rename the original file is intact;
 * the `finally` block reopens it and restarts long-lived consumers.
 */
export async function restoreDatabaseFromBackup(
  liveDbPath: string,
  input: string | Uint8Array,
  options: LiveRestoreOptions = {},
): Promise<LiveRestoreResult> {
  if (!liveDbPath || liveDbPath === ":memory:") {
    throw new RestoreError(
      500,
      "restore_unsupported",
      "Live file-swap restore needs a file-backed DATABASE_PATH.",
    );
  }
  const document = await verifyUploadBackupAsync(input, {
    hmacKey: options.hmacKey,
  });
  const backupDir = path.resolve(options.backupDir ?? resolveBackupDir());
  const livePath = path.resolve(liveDbPath);
  const liveDir = path.dirname(livePath);
  const tempPath = path.join(
    liveDir,
    `.restore-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.db`,
  );

  if (!beginMaintenance("restore")) {
    throw new RestoreError(
      503,
      "restore_in_progress",
      "Another restore/maintenance operation is already active.",
    );
  }

  let swapped = false;
  let liveClosed = false;
  let reopened = false;
  let pre: Awaited<ReturnType<typeof exportBackup>> | null = null;
  let sessionsRevoked = 0;
  let thrown: unknown = null;
  const restarted: string[] = [];

  try {
    // 1. Drain writers that entered before the gate. New mutating requests are
    //    already answered with 503 by index.ts.
    const writesDrained = await waitForActiveWrites();
    if (!writesDrained) {
      throw new RestoreError(
        503,
        "restore_busy",
        "Timed out waiting for in-flight writes; retry the restore.",
      );
    }
    const ticksIdle = await waitForSchedulerIdle();
    if (!ticksIdle) {
      throw new RestoreError(
        503,
        "restore_busy",
        "Timed out waiting for the scheduler tick; retry the restore.",
      );
    }
    stopScheduler();
    await stopMcpServer();
    restarted.length = 0;

    await options.onMaintenance?.();

    // 2. Always snapshot first — the restore is reversible via this file.
    pre = await exportBackup(getDb() as unknown as BackupDb, {
      backupDir,
      status: "pre-restore",
    });

    // 3. Checkpoint and close the live handle, then copy to the temp DB. The
    //    copy is the base schema/data for applying the verified document; the
    //    live file is untouched until the rename below.
    const liveMode = fs.statSync(livePath).mode & 0o777;
    try {
      getDb().pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // A checkpoint failure is not fatal; closing still flushes the handle.
    }
    setDatabaseReopenBlocked(true);
    closeDb();
    liveClosed = true;
    fs.copyFileSync(livePath, tempPath);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      unlinkIfPresent(`${tempPath}${suffix}`);
    }

    // 4. Apply into the temp DB (openDatabase migrates first), with the
    //    integrity + foreign-key checks enforced inside the transaction.
    let applied: RestoreIntoDbResult | null = null;
    const temp = openDatabase({ path: tempPath });
    try {
      applied = restoreIntoDb(temp.sqlite as unknown as BackupDb, document, {
        actor: options.actor ?? "system",
        actorId: options.actorId ?? null,
        markResetRequired: true,
      });
      temp.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      temp.close();
    }
    if (!applied) {
      throw new RestoreError(500, "restore_failed", "Temp-DB restore produced no result.");
    }
    sessionsRevoked = applied.sessionsRevoked;
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      unlinkIfPresent(`${tempPath}${suffix}`);
    }
    fs.chmodSync(tempPath, liveMode);
    fsyncFile(tempPath);

    // 5. Drop old sidecars, then rename the fsynced temp over live in one
    //    atomic same-directory operation. A stale `-wal` must never survive.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      unlinkIfPresent(`${livePath}${suffix}`);
    }
    fs.renameSync(tempPath, livePath);
    swapped = true;
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      unlinkIfPresent(`${livePath}${suffix}`);
    }
    fsyncDirectory(liveDir);
  } catch (error) {
    thrown = error;
  } finally {
    if (!swapped) {
      try {
        unlinkIfPresent(tempPath);
      } catch {
        // temp cleanup is best-effort
      }
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        try {
          unlinkIfPresent(`${tempPath}${suffix}`);
        } catch {
          // best-effort
        }
      }
    }

    // Reopen the live handle whether the swap succeeded or not. If it fails we
    // keep the gate ON: serving requests against a missing/closed DB would be
    // worse than a visible maintenance window.
    setDatabaseReopenBlocked(false);
    try {
      getDb();
      reopened = true;
    } catch (reopenError) {
      setDatabaseReopenBlocked(true);
      if (!thrown) {
        thrown = new RestoreError(
          500,
          "restore_reopen_failed",
          `Restore ${swapped ? "swapped the DB file" : "closed the DB"} but the live database could not be reopened. ${liveClosed ? "The pre-restore backup is intact." : ""}`,
        );
      }
      void reopenError;
    }

    if (reopened) {
      const health = databaseIntegrity(getDb());
      const integrityOk =
        health.integrity.length === 1 && health.integrity[0] === "ok";
      if (!integrityOk || health.foreignKeyViolations.length > 0) {
        // Keep the maintenance gate ON and do not rebind consumers onto a
        // corrupt restored database; a restart/re-restore is required.
        thrown = new RestoreError(
          500,
          "restore_integrity_failed",
          "Restored database failed post-swap integrity checks. The maintenance gate remains active.",
        );
      } else {
        try {
          ensureOwnerRole();
        } catch {
          // Startup/readiness will retry role repair on the next boot.
        }
        try {
          invalidateSseClients();
        } catch {
          // SSE invalidation is best-effort; clients also fail over/reconnect.
        }
        try {
          if (rebindAssistant(getDb())) restarted.push("assistant");
        } catch {
          // Report-only: routes will surface a normal 500 until the next restart.
        }
        try {
          if (restartSchedulerAfterRestore()) restarted.push("scheduler");
        } catch {
          // Report-only.
        }
        try {
          if (await restartMcpServerAfterRestore()) restarted.push("mcp");
        } catch {
          // MCP is optional; the reminder core must still come back.
        }
        endMaintenance();
      }
    }
  }

  if (thrown) {
    // On a failed reopen/integrity check the gate stays active so /readyz
    // cannot be green against a closed or corrupt DB; only a process restart
    // or another restore can recover.
    throw thrown;
  }

  const counts = {
    lists: document.data.lists.length,
    listMembers: (document.data.listMembers ?? []).length,
    tags: (document.data.tags ?? []).length,
    tasks: document.data.tasks.length,
    taskTags: (document.data.taskTags ?? []).length,
    subtasks: (document.data.subtasks ?? []).length,
    taskCompletions: document.data.taskCompletions.length,
    settings: Object.keys(document.data.settings).length,
    conversations: document.data.conversations.length,
    activity: document.data.activity.length,
  };
  return {
    preRestore: {
      path: pre?.path ?? "",
      sha256: pre?.sha256 ?? "",
      bytes: pre?.bytesWritten ?? 0,
    },
    counts,
    sessionsRevoked,
    passwordResetRequired: true,
    pushResubscribeRequired: true,
    maintenance: { active: false, restarted },
  };
}

/** Live-DB snapshot of allowlisted data (used for dryRun diffs). */
export function readLiveBackupData(): BackupData {
  return readBackupDataSnapshot(getDb() as unknown as BackupDb);
}
