import { openDB, type DBSchema, type IDBPDatabase } from "idb";

/** FIFO operation created while offline. Replayed by M2's outbox runner. */
export interface OutboxRecord {
  opId: string;
  kind: "create" | "update" | "complete" | "snooze" | "skip" | "delete";
  entityId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  lastError?: string;
  conflict?: boolean;
}

interface MorrowDB extends DBSchema {
  outbox: {
    key: string;
    value: OutboxRecord;
    indexes: { "by-created": string };
  };
  query: {
    key: string;
    value: unknown;
  };
}

let dbPromise: Promise<IDBPDatabase<MorrowDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<MorrowDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MorrowDB>("morrow", 1, {
      upgrade(db) {
        const outbox = db.createObjectStore("outbox", { keyPath: "opId" });
        outbox.createIndex("by-created", "createdAt");
        db.createObjectStore("query");
      },
    });
  }
  return dbPromise;
}

export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  try {
    const db = await dbPromise;
    db.close();
  } catch {
    // The database may already be closed or unavailable.
  } finally {
    dbPromise = null;
  }
}
