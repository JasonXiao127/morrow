import { describe, expect, it } from "vitest";
import {
  activityToJson,
  getActivity,
  listActivity,
  pruneActivity,
  recordActivity,
  undoActivity,
  ActivityError,
  type ActivityDb,
} from "../src/activity.js";
import { memActivityDb } from "./helpers.js";

const NOW = "2026-11-02T12:00:00.000Z";
const USER_ID = "01900000-0000-7000-8000-000000000001";
const TASK_ID = "01900000-0000-7000-8000-000000000003";

function memDb() {
  return memActivityDb();
}

function seedTask(db: ActivityDb): Record<string, unknown> {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, timezone, rev, created_at, updated_at)
     VALUES (?, 'owner', 'x', 'UTC', 1, ?, ?)`,
  ).run(USER_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO tasks (id, user_id, title, rev, created_at, updated_at)
     VALUES (?, ?, 'Milk', 1, ?, ?)`,
  ).run(TASK_ID, USER_ID, NOW, NOW);
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(TASK_ID) as Record<
    string,
    unknown
  >;
}

describe("activity log + undo", () => {
  it("records rows with a monotonic seq cursor for SSE replay", () => {
    const { db, close } = memDb();
    try {
      const first = recordActivity(db, {
        actor: "user",
        actorId: USER_ID,
        action: "task.create",
        entityType: "task",
        entityId: TASK_ID,
      });
      const second = recordActivity(db, {
        actor: "user",
        actorId: USER_ID,
        action: "task.update",
        entityType: "task",
        entityId: TASK_ID,
      });
      expect(second).toBeGreaterThan(first);

      const all = listActivity(db, { cursor: 0 });
      expect(all.rows).toHaveLength(2);
      expect(all.cursor).toBe(second);

      const replay = listActivity(db, { cursor: first });
      expect(replay.rows.map((r) => r.seq)).toEqual([second]);
      expect(getActivity(db, second)?.action).toBe("task.update");
      expect(activityToJson(getActivity(db, second)!).action).toBe("task.update");
    } finally {
      close();
    }
  });

  it("returns latest-first history with a backward cursor", () => {
    const { db, close } = memDb();
    try {
      const first = recordActivity(db, {
        actor: "user",
        actorId: USER_ID,
        action: "task.create",
        entityType: "task",
        entityId: TASK_ID,
      });
      const second = recordActivity(db, {
        actor: "user",
        actorId: USER_ID,
        action: "task.update",
        entityType: "task",
        entityId: TASK_ID,
      });

      const latest = listActivity(db, { order: "desc", limit: 1 });
      expect(latest.rows.map((row) => row.seq)).toEqual([second]);
      expect(latest.cursor).toBe(second);

      const older = listActivity(db, {
        order: "desc",
        cursor: latest.cursor,
        limit: 1,
      });
      expect(older.rows.map((row) => row.seq)).toEqual([first]);
    } finally {
      close();
    }
  });

  it("prunes old activity in batches and keeps recent rows", () => {
    const { db, close } = memDb();
    try {
      recordActivity(db, {
        actor: "user",
        actorId: USER_ID,
        action: "task.create",
        entityType: "task",
        entityId: TASK_ID,
        createdAt: "2024-01-01T00:00:00.000Z",
      });
      recordActivity(db, {
        actor: "user",
        actorId: USER_ID,
        action: "task.update",
        entityType: "task",
        entityId: TASK_ID,
        createdAt: "2024-01-02T00:00:00.000Z",
      });
      const recent = recordActivity(db, {
        actor: "user",
        actorId: USER_ID,
        action: "task.complete",
        entityType: "task",
        entityId: TASK_ID,
        createdAt: NOW,
      });

      const pruned = pruneActivity(db, {
        before: "2025-01-01T00:00:00.000Z",
        batchSize: 1,
      });
      expect(pruned).toBe(2);
      expect(
        listActivity(db, { order: "desc" }).rows.map((row) => row.seq),
      ).toEqual([recent]);
    } finally {
      close();
    }
  });

  it("undo reverts a title update with a rev bump + .undo audit row", () => {
    const { db, close } = memDb();
    try {
      const before = seedTask(db);
      db.prepare("UPDATE tasks SET title = 'Silk', rev = 2, updated_at = ? WHERE id = ?").run(
        "2026-11-03T00:00:00.000Z",
        TASK_ID,
      );
      const after = db.prepare("SELECT * FROM tasks WHERE id = ?").get(TASK_ID);

      const seq = recordActivity(db, {
        actor: "user",
        actorId: USER_ID,
        action: "task.update",
        entityType: "task",
        entityId: TASK_ID,
        before,
        after,
      });

      const result = undoActivity(db, seq, { actor: "user", actorId: USER_ID });
      expect(result.undoneSeq).toBe(seq);
      expect(result.row["title"]).toBe("Milk");
      expect(result.row["rev"]).toBe(3);

      const undoRow = getActivity(db, result.seq);
      expect(undoRow?.action).toBe("task.update.undo");

      // Undo rows cannot be undone again (append-only log).
      expect(() => undoActivity(db, result.seq)).toThrow(ActivityError);
    } finally {
      close();
    }
  });

  it("undo of a delete restores the row from trash", () => {
    const { db, close } = memDb();
    try {
      const before = seedTask(db);
      db.prepare("UPDATE tasks SET deleted_at = ?, rev = 2 WHERE id = ?").run(
        "2026-11-03T00:00:00.000Z",
        TASK_ID,
      );
      const seq = recordActivity(db, {
        actor: "user",
        action: "task.delete",
        entityType: "task",
        entityId: TASK_ID,
        before,
        after: null,
      });

      const result = undoActivity(db, seq, { actor: "user" });
      expect(result.row["deleted_at"]).toBeNull();
      expect(result.row["rev"]).toBe(3);
    } finally {
      close();
    }
  });

  it("undo of a create soft-deletes the row", () => {
    const { db, close } = memDb();
    try {
      seedTask(db);
      const after = db.prepare("SELECT * FROM tasks WHERE id = ?").get(TASK_ID);
      const seq = recordActivity(db, {
        actor: "user",
        action: "task.create",
        entityType: "task",
        entityId: TASK_ID,
        before: null,
        after,
      });

      const result = undoActivity(db, seq, { actor: "user" });
      expect(result.row["deleted_at"]).not.toBeNull();
    } finally {
      close();
    }
  });

  it("undo conflicts when the row changed since (stale base rev)", () => {
    const { db, close } = memDb();
    try {
      const before = seedTask(db);
      db.prepare("UPDATE tasks SET title = 'Silk', rev = 2 WHERE id = ?").run(TASK_ID);
      const after = db.prepare("SELECT * FROM tasks WHERE id = ?").get(TASK_ID);
      const seq = recordActivity(db, {
        actor: "user",
        action: "task.update",
        entityType: "task",
        entityId: TASK_ID,
        before,
        after,
      });
      // Someone else edits after the recorded `after` snapshot.
      db.prepare("UPDATE tasks SET title = 'Oat', rev = 3 WHERE id = ?").run(TASK_ID);
      expect(() => undoActivity(db, seq)).toThrow(
        expect.objectContaining({ code: "undo_conflict" }),
      );
      // Title untouched by the failed undo.
      const current = db.prepare("SELECT * FROM tasks WHERE id = ?").get(TASK_ID) as Record<string, unknown>;
      expect(current["title"]).toBe("Oat");
    } finally {
      close();
    }
  });

  it("rejects undo for non-task entities and missing rows", () => {
    const { db, close } = memDb();
    try {
      const seq = recordActivity(db, {
        actor: "system",
        action: "backup.restore",
        entityType: "backup",
        entityId: "abc",
      });
      expect(() => undoActivity(db, seq)).toThrow(
        expect.objectContaining({ code: "not_undoable" }),
      );
      expect(() => undoActivity(db, 999_999)).toThrow(
        expect.objectContaining({ code: "not_found" }),
      );
    } finally {
      close();
    }
  });

  it("rejects a hostile snapshot key instead of interpolating it into SQL", () => {
    const { db, close } = memDb();
    try {
      const before = seedTask(db);
      db.prepare("UPDATE tasks SET title = 'Silk', rev = 2, updated_at = ? WHERE id = ?").run(
        "2026-11-03T00:00:00.000Z",
        TASK_ID,
      );
      const after = db.prepare("SELECT * FROM tasks WHERE id = ?").get(TASK_ID);
      // Auditor's second-order payload: smuggled in via before_json, it would
      // break out of the quoted identifier and run a subselect if column
      // names were interpolated unchecked.
      const hostileBefore = {
        ...before,
        'notes" = (SELECT sqlite_version()) --': "exfiltrated",
      };
      const seq = recordActivity(db, {
        actor: "user",
        actorId: USER_ID,
        action: "task.update",
        entityType: "task",
        entityId: TASK_ID,
        before: hostileBefore,
        after,
      });
      expect(() => undoActivity(db, seq, { actor: "user", actorId: USER_ID })).toThrow(
        expect.objectContaining({ code: "invalid_snapshot" }),
      );
      // Nothing executed: the live row is untouched and no table leaked.
      const current = db.prepare("SELECT * FROM tasks WHERE id = ?").get(TASK_ID) as Record<string, unknown>;
      expect(current["title"]).toBe("Silk");
      expect(current["rev"]).toBe(2);
      expect(Object.keys(current)).not.toContain(
        'notes" = (SELECT sqlite_version()) --',
      );
    } finally {
      close();
    }
  });

  it("stores a hostile snapshot value literally (bound parameter, not SQL)", () => {
    const { db, close } = memDb();
    try {
      const seed = seedTask(db);
      const payload = 'x" = (SELECT sqlite_version()) --';
      // The payload sits in a legitimate column of the *before* snapshot, so
      // a correct undo must write it back as data.
      const beforeWithPayload = { ...seed, notes: payload };
      db.prepare("UPDATE tasks SET title = 'Silk', rev = 2, updated_at = ? WHERE id = ?").run(
        "2026-11-03T00:00:00.000Z",
        TASK_ID,
      );
      const after = db.prepare("SELECT * FROM tasks WHERE id = ?").get(TASK_ID);
      const seq = recordActivity(db, {
        actor: "user",
        actorId: USER_ID,
        action: "task.update",
        entityType: "task",
        entityId: TASK_ID,
        before: beforeWithPayload,
        after,
      });
      const result = undoActivity(db, seq, { actor: "user", actorId: USER_ID });
      // The payload round-trips as data: stored literally, never executed.
      expect(result.row["notes"]).toBe(payload);
      expect(result.row["title"]).toBe("Milk");
      const live = db.prepare("SELECT notes FROM tasks WHERE id = ?").get(TASK_ID) as {
        notes: string;
      };
      expect(live.notes).toBe(payload);
    } finally {
      close();
    }
  });
});
