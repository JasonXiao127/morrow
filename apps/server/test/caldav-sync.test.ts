/**
 * Unit coverage for the CalDAV change journal: per-user isolation, tag
 * triggers, and retention expiry. Route-level sync semantics live in
 * caldav.test.ts.
 */
import { describe, expect, it } from "vitest";
import { openDatabase, type MorrowDatabase } from "@morrow/db";
import {
  changesSince,
  isUsableSyncToken,
  maxChangeSeq,
  parseSyncToken,
  pruneChanges,
  syncTokenFor,
} from "../src/caldavSync.js";

const NOW = "2026-11-08T09:00:00.000Z";
const USER_A = "01900000-0000-7000-8000-0000000000a1";
const USER_B = "01900000-0000-7000-8000-0000000000b1";

function insertUser(
  database: MorrowDatabase,
  id: string,
  username: string,
  role: "owner" | "member",
): void {
  database.sqlite
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, timezone, created_at, updated_at)
       VALUES (?, ?, 'not-a-real-hash', ?, 'UTC', ?, ?)`,
    )
    .run(id, username, role, NOW, NOW);
}

function insertTask(
  database: MorrowDatabase,
  id: string,
  userId: string,
  title: string,
): void {
  database.sqlite
    .prepare(
      `INSERT INTO tasks (id, user_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, userId, title, NOW, NOW);
}

describe("CalDAV change journal", () => {
  it("isolates changes by user", () => {
    const database = openDatabase({ path: ":memory:" });
    try {
      insertUser(database, USER_A, "owner", "owner");
      insertUser(database, USER_B, "member", "member");
      insertTask(database, "task-a", USER_A, "Owner task");
      insertTask(database, "task-b", USER_B, "Member task");

      const aChanges = changesSince(database.sqlite, USER_A, 0);
      expect(aChanges.map((row) => row.task_id)).toContain("task-a");
      expect(aChanges.map((row) => row.task_id)).not.toContain("task-b");

      // Even if A's token is replayed under B, the query is still scoped to B.
      const aToken = parseSyncToken(syncTokenFor(database.sqlite, USER_A));
      expect(aToken).not.toBeNull();
      // Add a later B change so the replay assertion cannot pass vacuously.
      insertTask(database, "task-b2", USER_B, "Later member task");
      const bAfterA = changesSince(database.sqlite, USER_B, aToken!.seq);
      expect(bAfterA.map((row) => row.task_id)).toContain("task-b2");
      expect(bAfterA.map((row) => row.task_id)).not.toContain("task-a");
    } finally {
      database.close();
    }
  });

  it("journals tag renames for every linked task", () => {
    const database = openDatabase({ path: ":memory:" });
    try {
      insertUser(database, USER_A, "owner", "owner");
      insertTask(database, "task-a", USER_A, "Owner task");
      database.sqlite
        .prepare(
          `INSERT INTO tags (id, user_id, name, rev, created_at, updated_at)
           VALUES ('tag-a', ?, 'Original', 1, ?, ?)`,
        )
        .run(USER_A, NOW, NOW);
      database.sqlite
        .prepare(
          `INSERT INTO task_tags (task_id, tag_id, created_at) VALUES ('task-a', 'tag-a', ?)`,
        )
        .run(NOW);

      const before = maxChangeSeq(database.sqlite, USER_A);
      database.sqlite
        .prepare(
          `UPDATE tags SET name = 'Renamed', rev = rev + 1, updated_at = ? WHERE id = 'tag-a'`,
        )
        .run("2026-11-08T10:00:00.000Z");

      const after = changesSince(database.sqlite, USER_A, before);
      expect(after.some((row) => row.task_id === "task-a")).toBe(true);
    } finally {
      database.close();
    }
  });

  it("retains the newest 40k rows when the 50k cap is crossed", () => {
    const database = openDatabase({ path: ":memory:" });
    try {
      insertUser(database, USER_A, "owner", "owner");
      insertTask(database, "task-a", USER_A, "Owner task");
      const token = parseSyncToken(syncTokenFor(database.sqlite, USER_A));
      expect(token).not.toBeNull();
      expect(isUsableSyncToken(database.sqlite, USER_A, token!)).toBe(true);

      const insert = database.sqlite.prepare(
        `INSERT INTO caldav_changes
           (collection, user_id, task_id, href, change_type, changed_at)
         VALUES ('inbox', ?, 'task-a', ?, 'update', ?)`,
      );
      const bulk = database.sqlite.transaction(() => {
        for (let index = 0; index < 50_100; index += 1) {
          insert.run(USER_A, `bulk-${index}.ics`, NOW);
        }
      });
      bulk();
      expect(
        (
          database.sqlite
            .prepare("SELECT COUNT(*) AS n FROM caldav_changes")
            .get() as { n: number }
        ).n,
      ).toBeGreaterThan(50_000);

      pruneChanges(database.sqlite, 40_000);
      const after = database.sqlite
        .prepare(
          "SELECT COUNT(*) AS n, MIN(seq) AS first FROM caldav_changes",
        )
        .get() as { n: number; first: number };
      expect(after.n).toBe(40_000);
      expect(after.first).toBeGreaterThan(token!.seq + 1);
      expect(isUsableSyncToken(database.sqlite, USER_A, token!)).toBe(false);
    } finally {
      database.close();
    }
  });

  it("invalidates tokens whose journal window was pruned", () => {
    const database = openDatabase({ path: ":memory:" });
    try {
      insertUser(database, USER_A, "owner", "owner");
      insertUser(database, USER_B, "member", "member");
      insertTask(database, "task-a", USER_A, "Owner task");
      insertTask(database, "task-b", USER_B, "Member task");

      const token = parseSyncToken(syncTokenFor(database.sqlite, USER_A));
      expect(token).not.toBeNull();
      expect(isUsableSyncToken(database.sqlite, USER_A, token!)).toBe(true);

      insertTask(database, "task-a2", USER_A, "Later owner task");
      insertTask(database, "task-b2", USER_B, "Later member task");
      pruneChanges(database.sqlite, 1);
      expect(isUsableSyncToken(database.sqlite, USER_A, token!)).toBe(false);
    } finally {
      database.close();
    }
  });
});
