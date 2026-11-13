/**
 * SQLite client (§3).
 *
 * Every connection is configured before it is handed out:
 *   journal_mode = WAL
 *   busy_timeout = 5000
 *   foreign_keys = ON
 *   synchronous  = FULL
 *
 * `getDb()` keeps the app-server skeleton's raw better-sqlite3 API and now
 * runs Drizzle migrations on first open. `openDatabase()` returns both the
 * raw connection and the typed Drizzle client (used by tests and new code).
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export type BetterDb = Database.Database;
export type MorrowDb = BetterSQLite3Database<typeof schema>;

export interface OpenDatabaseOptions {
  /** Defaults to DATABASE_PATH or ./data/morrow.db. */
  path?: string;
  /** Defaults to true. */
  migrate?: boolean;
  /** Defaults to packages/db/migrations next to this module. */
  migrationsFolder?: string;
  /** Create a raw SQLite snapshot before applying pending migrations. */
  backupBeforeMigrate?: boolean;
  /** Number of pre-migration snapshots to keep. Defaults to 3. */
  keepMigrationBackups?: number;
}

export interface MorrowDatabase {
  sqlite: BetterDb;
  db: MorrowDb;
  close: () => void;
}

let singleton: MorrowDatabase | null = null;

export function resolveDatabasePath(): string {
  return (
    process.env["DATABASE_PATH"] ??
    path.join(process.cwd(), "data", "morrow.db")
  );
}

/**
 * Resolves to packages/db/migrations both when running from src (tsx/vitest)
 * and when running from dist (compiled server).
 */
export function resolveMigrationsFolder(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

export interface MigrationStatus {
  /** Latest applied migration timestamp (`folderMillis`), or null. */
  applied: number | null;
  /** Latest bundled migration timestamp, or null. */
  bundled: number | null;
  /** Bundled migrations not yet applied. */
  pending: number;
  /** True when the database is ahead of this app build. */
  newer: boolean;
  appliedCount: number;
  bundledCount: number;
}

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function readJournal(migrationsFolder: string): JournalEntry[] {
  const file = path.join(migrationsFolder, "meta", "_journal.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    entries?: JournalEntry[];
  };
  return (parsed.entries ?? [])
    .slice()
    .sort((left, right) => left.when - right.when);
}

function readAppliedMigrations(
  sqlite: BetterDb,
): Array<{ created_at: number }> {
  try {
    return sqlite
      .prepare(
        "SELECT created_at FROM __drizzle_migrations ORDER BY created_at ASC",
      )
      .all() as Array<{ created_at: number }>;
  } catch {
    return [];
  }
}

/**
 * Compare the database's applied migration watermark with the bundled
 * migrations. A database ahead of the app means the app was rolled back after
 * a newer version migrated it; starting silently would be unsafe.
 */
export function migrationStatus(
  sqlite: BetterDb,
  migrationsFolder = resolveMigrationsFolder(),
): MigrationStatus {
  const journal = readJournal(migrationsFolder);
  const appliedRows = readAppliedMigrations(sqlite);
  const applied =
    appliedRows.length > 0
      ? Number(appliedRows[appliedRows.length - 1]?.created_at)
      : null;
  const bundled =
    journal.length > 0 ? Number(journal[journal.length - 1]?.when) : null;
  return {
    applied,
    bundled,
    pending: journal.filter(
      (entry) => applied === null || entry.when > applied,
    ).length,
    newer:
      applied !== null &&
      bundled !== null &&
      Number.isFinite(applied) &&
      Number.isFinite(bundled) &&
      applied > bundled,
    appliedCount: appliedRows.length,
    bundledCount: journal.length,
  };
}

/** Fail closed when the database schema is newer than this app build. */
export function assertDatabaseNotNewer(
  sqlite: BetterDb,
  migrationsFolder = resolveMigrationsFolder(),
): MigrationStatus {
  const status = migrationStatus(sqlite, migrationsFolder);
  if (status.newer) {
    throw new Error(
      `Database schema is newer than this app build (applied migration ${status.applied}, bundled ${status.bundled}). Upgrade the app or restore a pre-upgrade backup.`,
    );
  }
  return status;
}

function hasUserTables(sqlite: BetterDb): boolean {
  const row = sqlite
    .prepare(
      `SELECT 1 AS present FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1`,
    )
    .get() as { present?: number } | undefined;
  return row?.present === 1;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function pruneMigrationBackups(databasePath: string, keep: number): void {
  const dir = path.dirname(databasePath);
  const prefix = `${path.basename(databasePath)}.pre-migration-`;
  let entries: Array<{ name: string; full: string; mtime: number }>;
  try {
    entries = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => {
        const full = path.join(dir, name);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          // Keep the entry; it may disappear between readdir and stat.
        }
        return { name, full, mtime };
      })
      .sort(
        (left, right) =>
          left.mtime - right.mtime || left.name.localeCompare(right.name),
      );
  } catch {
    return;
  }
  const remove = entries.slice(0, Math.max(0, entries.length - keep));
  for (const entry of remove) {
    try {
      fs.unlinkSync(entry.full);
    } catch {
      // Best-effort cleanup; the new snapshot is already durable.
    }
  }
}

export interface MigrationBackupOptions {
  /** Number of pre-migration snapshots to keep. Defaults to 3. */
  keep?: number;
}

/**
 * Snapshot the live DB before pending migrations. `VACUUM INTO` writes a
 * consistent standalone SQLite file even in WAL mode. This is the recovery
 * point for a failed upgrade or a later rollback; migrations themselves run in
 * Drizzle's transaction, so a failed migration also rolls back cleanly.
 */
export function backupBeforeMigration(
  sqlite: BetterDb,
  databasePath: string,
  options: MigrationBackupOptions = {},
): string | null {
  if (databasePath === ":memory:" || !hasUserTables(sqlite)) return null;
  const keep = Math.max(1, options.keep ?? 3);
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  const target = `${databasePath}.pre-migration-${stamp}-${randomUUID().slice(0, 8)}.bak`;
  sqlite.exec(`VACUUM INTO ${quoteSqlString(target)}`);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // The snapshot exists; mode tightening is best-effort.
  }
  pruneMigrationBackups(databasePath, keep);
  return target;
}

function verifyForeignKeys(sqlite: BetterDb): void {
  const violations = sqlite.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Database foreign-key check failed after migration (${violations.length} violation(s)); refusing to start.`,
    );
  }
}

function applyPragmas(sqlite: BetterDb): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = FULL");

  const foreignKeys = sqlite.pragma("foreign_keys", { simple: true });
  if (foreignKeys !== 1) {
    throw new Error("SQLite foreign_keys pragma could not be enabled");
  }
}

/** Run migrations on an existing connection (idempotent). */
export function migrateDatabase(
  sqlite: BetterDb,
  migrationsFolder = resolveMigrationsFolder(),
): void {
  assertDatabaseNotNewer(sqlite, migrationsFolder);
  migrate(drizzle(sqlite, { schema }), { migrationsFolder });
  verifyForeignKeys(sqlite);
}

/**
 * Open a connection, configure pragmas, and migrate. Caller owns `close()`.
 */
export function openDatabase(
  options: OpenDatabaseOptions = {},
): MorrowDatabase {
  const databasePath = options.path ?? resolveDatabasePath();
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const sqlite = new Database(databasePath);
  try {
    applyPragmas(sqlite);
    const db = drizzle(sqlite, { schema });
    if (options.migrate !== false) {
      const migrationsFolder =
        options.migrationsFolder ?? resolveMigrationsFolder();
      const status = assertDatabaseNotNewer(sqlite, migrationsFolder);
      if (options.backupBeforeMigrate && status.pending > 0) {
        backupBeforeMigration(sqlite, databasePath, {
          keep: options.keepMigrationBackups,
        });
      }
      migrate(db, { migrationsFolder });
      verifyForeignKeys(sqlite);
    }
    return {
      sqlite,
      db,
      close: () => {
        if (sqlite.open) sqlite.close();
      },
    };
  } catch (err) {
    try {
      sqlite.close();
    } catch {
      // Keep the original error.
    }
    throw err;
  }
}

/**
 * Backwards-compatible singleton used by the app-server skeleton.
 * First call configures pragmas and runs migrations.
 */
export function getDb(): BetterDb {
  if (singleton) return singleton.sqlite;
  if (reopenBlocked) {
    throw new Error("database is being restored; retry after maintenance");
  }
  singleton = openDatabase({ backupBeforeMigrate: true });
  return singleton.sqlite;
}

let reopenBlocked = false;

/**
 * Live restore hook: while the database file is being swapped, a read must
 * not transparently reopen the singleton and race the atomic rename.
 */
export function setDatabaseReopenBlocked(blocked: boolean): void {
  reopenBlocked = blocked;
}

/** Typed Drizzle client for the singleton connection. */
export function getMorrowDb(): MorrowDb {
  if (!singleton) {
    if (reopenBlocked) {
      throw new Error("database is being restored; retry after maintenance");
    }
    singleton = openDatabase({ backupBeforeMigrate: true });
  }
  return singleton.db;
}

export function closeDb(): void {
  if (!singleton) return;
  try {
    singleton.close();
  } catch {
    // ignore close errors during shutdown
  } finally {
    singleton = null;
  }
}

/**
 * Compatibility shim from the first app-server skeleton. New code should let
 * `getDb()`/`openDatabase()` migrate automatically.
 */
export function initSchema(database?: BetterDb): void {
  if (database) {
    migrateDatabase(database);
    return;
  }
  getDb();
}

/** Liveness probe for /readyz: SELECT 1. Throws on failure. */
export function pingDb(database?: BetterDb): void {
  const d = database ?? getDb();
  const row = d.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
  if (!row || row.ok !== 1) throw new Error("db ping failed");
}

export interface IntegrityReport {
  integrity: string[];
  foreignKeyViolations: unknown[];
}

/** Used before/after backup restore (§3). */
export function databaseIntegrity(sqlite: BetterDb): IntegrityReport {
  const integrity = (sqlite.pragma("integrity_check") as Array<{
    integrity_check: string;
  }>).map((row) => row.integrity_check);
  const foreignKeyViolations = sqlite.pragma("foreign_key_check") as unknown[];
  return { integrity, foreignKeyViolations };
}

/** Test helper: list user tables, excluding SQLite internals. */
export function listTables(sqlite: BetterDb): string[] {
  const rows = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

export { schema };
