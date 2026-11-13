import type {
  PersistedClient,
  Persister,
} from "@tanstack/react-query-persist-client";
import { getDb } from "./idb";

const CACHE_KEY = "morrow.query-cache.v1";

/**
 * Stub-complete TanStack Query persistence (M1/M2).
 *
 * Only read queries in PERSISTED_KEYS are written to IndexedDB. Nothing from
 * /api is cached by the service worker. The persisted cache is purged on
 * logout/session expiry along with the outbox database.
 */
const PERSISTED_KEYS = new Set(["bootstrap"]);

let persistenceEnabled = true;

/** Stop the persister while a logout/session purge deletes the database. */
export function setQueryPersistenceEnabled(enabled: boolean): void {
  persistenceEnabled = enabled;
}

export const queryPersister: Persister = {
  async persistClient(client: PersistedClient) {
    if (!persistenceEnabled) return;
    try {
      const db = await getDb();
      if (!persistenceEnabled) return;
      await db.put("query", client, CACHE_KEY);
    } catch (error) {
      console.warn("[morrow] could not persist query cache", error);
      throw error;
    }
  },

  async restoreClient(): Promise<PersistedClient | undefined> {
    const db = await getDb();
    return (await db.get("query", CACHE_KEY)) as PersistedClient | undefined;
  },

  async removeClient() {
    const db = await getDb();
    await db.delete("query", CACHE_KEY);
  },
};

export const persistOptions = {
  persister: queryPersister,
  // Keep the last authenticated snapshot through a long offline stretch
  // (travel, a long weekend). Keep it aligned with the session lifetime rather
  // than exposing an old authenticated snapshot for a month.
  maxAge: 7 * 24 * 60 * 60 * 1_000,
  buster: "morrow-v1",
  dehydrateOptions: {
    shouldDehydrateQuery: (query: {
      queryKey: readonly unknown[];
      state: { status: string };
    }) =>
      query.state.status === "success" &&
      PERSISTED_KEYS.has(String(query.queryKey[0] ?? "")),
    shouldDehydrateMutation: () => false,
  },
};
