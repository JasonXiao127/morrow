import { api } from "@/api";
import { clearAppBadge } from "./badge";
import { getDb } from "./idb";
import { queryClient } from "./query";
import {
  queryPersister,
  setQueryPersistenceEnabled,
} from "./query-persistence";
import { purgeLocalData } from "./storage";
import { clearUndo } from "./undo";

/**
 * End the current session and remove all local app state.
 * Never let a failed logout request keep task data in the browser.
 */
export async function endSession(options: { expired?: boolean } = {}): Promise<void> {
  // The persister must be quiet before the database is deleted, otherwise its
  // subscription reopens the DB while deletion is in flight.
  setQueryPersistenceEnabled(false);
  if (!options.expired) {
    try {
      await api.logout();
    } catch {
      // Offline or already revoked: local purge still matters.
    }
  }
  clearUndo();
  await clearAppBadge();
  await purgeLocalData();
  queryClient.clear();
}

/** Bound local-storage cleanup so a blocked tab can never strand a login. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Clear any pre-session cache after a successful setup/login. */
export async function prepareFreshSession(): Promise<void> {
  setQueryPersistenceEnabled(false);
  const cleanup = (async () => {
    try {
      await queryPersister.removeClient();
    } catch {
      // A missing DB is expected on first setup.
    }
    try {
      // A prior account may have left an outbox. Never replay it under the
      // new session.
      const db = await getDb();
      await db.clear("outbox");
    } catch {
      // Best effort; the sign-out purge usually removed the database already.
    }
  })();
  await withTimeout(cleanup, 2_000);
  queryClient.clear();
  setQueryPersistenceEnabled(true);
}
