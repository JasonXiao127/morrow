/**
 * Workspace epoch.
 *
 * Bumped whenever a restore or import replaces the database. Clients keep the
 * value they last saw in IndexedDB/localStorage; a mismatch means queued
 * offline mutations were created against a different workspace state and must
 * not be replayed blindly.
 *
 * The value lives in the existing `settings` table so no migration is needed.
 */
import { nowIso } from "@morrow/shared";

export const WORKSPACE_EPOCH_KEY = "workspace.epoch";

export interface SettingsHandle {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

function parseEpoch(value: unknown): number {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      // Legacy rows may store the raw number.
      parsed = value;
    }
  }
  const number =
    typeof parsed === "number" ? parsed : Number.parseInt(String(parsed), 10);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

/** Current epoch. Missing or unreadable rows mean 0 (a pre-epoch workspace). */
export function readWorkspaceEpoch(db: SettingsHandle): number {
  try {
    const row = db
      .prepare(
        "SELECT value FROM settings WHERE key = ? AND deleted_at IS NULL",
      )
      .get(WORKSPACE_EPOCH_KEY) as { value?: unknown } | undefined;
    return row ? parseEpoch(row.value) : 0;
  } catch {
    return 0;
  }
}

/**
 * Rotate the epoch. Best-effort: a handle without the settings table still
 * returns the next value so the caller can continue a restore.
 */
export function bumpWorkspaceEpoch(db: SettingsHandle): number {
  const next = readWorkspaceEpoch(db) + 1;
  try {
    db.prepare(
      `INSERT INTO settings (key, value, rev, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         rev = rev + 1, updated_at = excluded.updated_at, deleted_at = NULL`,
    ).run(WORKSPACE_EPOCH_KEY, JSON.stringify(next), nowIso());
  } catch {
    // Restore invalidation is advisory; never fail the restore on it.
  }
  return next;
}
