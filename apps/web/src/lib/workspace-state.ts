/**
 * Workspace stamp stored beside the offline cache.
 *
 * The server bumps its epoch on every restore/import. IndexedDB is per-origin,
 * not per-user, so both the owner id and the epoch must match before the
 * outbox is replayed. A missing stamp is a first run and is adopted without a
 * purge; a mismatch clears the local outbox + query cache.
 */
export const WORKSPACE_OWNER_KEY = "morrow.ownerId";
export const WORKSPACE_EPOCH_KEY = "morrow.workspaceEpoch";

export interface WorkspaceStamp {
  userId: string;
  epoch: number;
}

export type WorkspaceDecision =
  | { reset: false; reason: "first" | "same" }
  | { reset: true; reason: "user" | "epoch" };

export function evaluateWorkspaceStamp(
  stored: WorkspaceStamp | null,
  current: WorkspaceStamp,
): WorkspaceDecision {
  if (
    !stored ||
    !stored.userId ||
    !Number.isSafeInteger(stored.epoch) ||
    stored.epoch < 0
  ) {
    return { reset: false, reason: "first" };
  }
  if (stored.userId !== current.userId) {
    return { reset: true, reason: "user" };
  }
  if (stored.epoch !== current.epoch) {
    return { reset: true, reason: "epoch" };
  }
  return { reset: false, reason: "same" };
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readWorkspaceStamp(
  storage: Storage | null = defaultStorage(),
): WorkspaceStamp | null {
  if (!storage) return null;
  try {
    const userId = storage.getItem(WORKSPACE_OWNER_KEY);
    const rawEpoch = storage.getItem(WORKSPACE_EPOCH_KEY);
    if (!userId || rawEpoch === null) return null;
    const epoch = Number.parseInt(rawEpoch, 10);
    if (!Number.isSafeInteger(epoch) || epoch < 0) return null;
    return { userId, epoch };
  } catch {
    return null;
  }
}

export function writeWorkspaceStamp(
  stamp: WorkspaceStamp,
  storage: Storage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(WORKSPACE_OWNER_KEY, stamp.userId);
    storage.setItem(WORKSPACE_EPOCH_KEY, String(stamp.epoch));
  } catch {
    // Storage can be unavailable (private mode, quota); the next launch simply
    // treats the workspace as new.
  }
}

export function clearWorkspaceStamp(
  storage: Storage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(WORKSPACE_OWNER_KEY);
    storage.removeItem(WORKSPACE_EPOCH_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}
