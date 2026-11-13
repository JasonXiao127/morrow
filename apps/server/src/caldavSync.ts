/**
 * CalDAV change journal + sync tokens (Phase 2).
 *
 * The journal is populated by SQLite triggers in migrations 0008-0013 so
 * every task, tag-link, attachment, recurrence-exception, and collection-move
 * mutation is recorded, including scheduler, undo, and restore writes that do
 * not go through a CalDAV route. Tokens are opaque to clients and carry a
 * restore epoch, collection key, and the last consumed sequence:
 *
 *   urn:morrow:sync:<epoch>:<collection>:<seq>
 *
 * `morrow` is the legacy flat collection (all tasks owned by the user),
 * `inbox` is the user's inbox, and every other key is a list id. A live
 * restore bumps the epoch, so every pre-restore token is rejected and the
 * client performs a full sync instead of silently missing changes.
 */
import { nowIso } from "@morrow/shared";

const SYNC_EPOCH_KEY = "caldav.syncEpoch";
const SYNC_TOKEN_PREFIX = "urn:morrow:sync:";
export const LEGACY_COLLECTION = "morrow";
export const INBOX_COLLECTION = "inbox";

/** Structural DB surface shared by the live handle and restore/test handles. */
export interface SyncDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

export interface CalDavChangeRow {
  seq: number;
  user_id: string;
  task_id: string;
  href: string;
  change_type: "create" | "update" | "delete";
  exception_id: string | null;
  changed_at: string;
}

export interface CalDavSyncToken {
  epoch: number;
  seq: number;
  collection: string;
}

function readEpochSetting(db: SyncDb): number {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ? AND deleted_at IS NULL")
      .get(SYNC_EPOCH_KEY) as { value: string } | undefined;
    if (!row) return 1;
    let parsed: unknown = row.value;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      // Legacy rows may store the raw number.
    }
    const value =
      typeof parsed === "number" ? parsed : Number.parseInt(String(parsed), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : 1;
  } catch {
    return 1;
  }
}

/** Current restore epoch; tokens from another epoch are invalid. */
export function readSyncEpoch(db: SyncDb): number {
  return readEpochSetting(db);
}

/** Invalidate every issued token without deleting regular task data. */
export function bumpSyncEpoch(db: SyncDb): number {
  const next = readEpochSetting(db) + 1;
  try {
    db.prepare(
      `INSERT INTO settings (key, value, rev, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         rev = rev + 1, updated_at = excluded.updated_at, deleted_at = NULL`,
    ).run(SYNC_EPOCH_KEY, JSON.stringify(next), nowIso());
  } catch {
    // A handle without settings cannot issue tokens anyway.
  }
  return next;
}

/**
 * Collection scoping:
 * - `morrow`: the user's own tasks across every list (legacy flat collection)
 * - `inbox`: the user's own inbox rows
 * - list id: every task in that list, including tasks created by other members
 */
function whereForCollection(
  collection: string,
  userId: string,
): { where: string; params: unknown[] } {
  if (collection === LEGACY_COLLECTION) {
    return { where: "user_id = ?", params: [userId] };
  }
  if (collection === INBOX_COLLECTION) {
    return {
      where: "user_id = ? AND collection = 'inbox'",
      params: [userId],
    };
  }
  return { where: "collection = ?", params: [collection] };
}

export function maxChangeSeqForCollection(
  db: SyncDb,
  userId: string,
  collection: string,
): number {
  try {
    const scope = whereForCollection(collection, userId);
    const row = db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM caldav_changes WHERE ${scope.where}`,
      )
      .get(...scope.params) as { seq: number } | undefined;
    return row?.seq ?? 0;
  } catch {
    return 0;
  }
}

/** Global journal position; sync tokens are cut from this so a collection
 *  with no changes still gets a stable boundary. */
function globalMaxSeq(db: SyncDb): number {
  try {
    const row = db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM caldav_changes")
      .get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  } catch {
    return 0;
  }
}

function globalMinSeq(db: SyncDb): number | null {
  try {
    const row = db
      .prepare("SELECT MIN(seq) AS seq FROM caldav_changes")
      .get() as { seq: number | null } | undefined;
    return row?.seq ?? null;
  } catch {
    return null;
  }
}

/** Backwards-compatible flat-collection helper. */
export function maxChangeSeq(db: SyncDb, userId: string): number {
  return maxChangeSeqForCollection(db, userId, LEGACY_COLLECTION);
}

export function syncTokenFor(
  db: SyncDb,
  userId: string,
  collection: string = LEGACY_COLLECTION,
): string {
  const epoch = readEpochSetting(db);
  // Use the global position so a collection with no rows still has a stable
  // boundary that later changes in that collection exceed.
  const seq = globalMaxSeq(db);
  return `${SYNC_TOKEN_PREFIX}${epoch}:${collection}:${seq}`;
}

/**
 * Accept the current four-part token and the pre-per-list three-part token
 * (`urn:morrow:sync:<epoch>:<seq>`, treated as the legacy flat collection).
 */
export function parseSyncToken(value: string): CalDavSyncToken | null {
  const escapedPrefix = SYNC_TOKEN_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const four = new RegExp(
    `^${escapedPrefix}(\\d+):([A-Za-z0-9_-]{1,64}):(\\d+)$`,
  ).exec(value.trim());
  if (four) {
    const epoch = Number.parseInt(four[1] as string, 10);
    const seq = Number.parseInt(four[3] as string, 10);
    if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(seq)) return null;
    if (epoch < 1 || seq < 0) return null;
    return { epoch, seq, collection: four[2] as string };
  }
  const three = new RegExp(`^${escapedPrefix}(\\d+):(\\d+)$`).exec(
    value.trim(),
  );
  if (!three) return null;
  const epoch = Number.parseInt(three[1] as string, 10);
  const seq = Number.parseInt(three[2] as string, 10);
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(seq)) return null;
  if (epoch < 1 || seq < 0) return null;
  return { epoch, seq, collection: LEGACY_COLLECTION };
}

/**
 * A token is usable when its epoch/collection is current, it does not point
 * past the latest change, and the journal still contains every row after it.
 */
export function isUsableSyncToken(
  db: SyncDb,
  userId: string,
  token: CalDavSyncToken,
  collection: string = LEGACY_COLLECTION,
): boolean {
  if (token.collection !== collection) return false;
  if (token.epoch !== readEpochSetting(db)) return false;
  if (token.seq > globalMaxSeq(db)) return false;
  // Pruning is global. If the token predates the retained window we cannot
  // prove which collection rows it would have missed, so force a full sync.
  const min = globalMinSeq(db);
  if (min === null) return token.seq === 0;
  return token.seq >= min - 1;
}

export function changesSinceCollection(
  db: SyncDb,
  userId: string,
  collection: string,
  seq: number,
): CalDavChangeRow[] {
  try {
    const scope = whereForCollection(collection, userId);
    return db
      .prepare(
        `SELECT seq, user_id, task_id, href, change_type, exception_id, changed_at
           FROM caldav_changes
          WHERE ${scope.where} AND seq > ?
          ORDER BY seq ASC`,
      )
      .all(...scope.params, seq) as CalDavChangeRow[];
  } catch {
    return [];
  }
}

/** Backwards-compatible flat-collection helper. */
export function changesSince(
  db: SyncDb,
  userId: string,
  seq: number,
): CalDavChangeRow[] {
  return changesSinceCollection(db, userId, LEGACY_COLLECTION, seq);
}

/**
 * Keep the journal bounded. Called opportunistically before a sync report;
 * tokens that now point before the retained window become invalid and fall
 * back to a full sync.
 */
export function pruneChanges(db: SyncDb, maxRows = 50_000): void {
  try {
    db.prepare(
      `DELETE FROM caldav_changes
        WHERE seq < (
          SELECT seq FROM caldav_changes
           ORDER BY seq DESC LIMIT 1 OFFSET ?
        )`,
    ).run(Math.max(0, maxRows - 1));
  } catch {
    // Pruning is best-effort; correctness does not depend on it.
  }
}

/** Restore invalidation: drop the journal and rotate the token epoch. */
export function invalidateCalDavSync(db: SyncDb): void {
  try {
    db.prepare("DELETE FROM caldav_changes").run();
  } catch {
    // Older handles may not have the journal yet.
  }
  bumpSyncEpoch(db);
}
