/**
 * Agent undo regressions: hostile stored snapshots must fail closed, and
 * batch undo must remove the exact task_completions row so complete → undo →
 * re-complete works for one-shot and recurring tasks.
 */
import { describe, expect, it } from "vitest";
import { openDatabase, type MorrowDatabase } from "@morrow/db";
import { newId } from "@morrow/shared";
import {
  QuotaTracker,
  TaskStore,
  callTool,
  undoActivityBatch,
  type McpToolContext,
} from "../src/index.js";

const USER_ID = "01900000-0000-7000-8000-000000000001";
const LIST_ID = "01900000-0000-7000-8000-000000000002";
const TASK_ID = "01900000-0000-7000-8000-000000000003";
const NOW = "2026-11-02T12:00:00.000Z";

function seed(): MorrowDatabase {
  const database = openDatabase({ path: ":memory:" });
  const db = database.sqlite;
  db.prepare(
    `INSERT INTO users (id, username, password_hash, timezone, rev, created_at, updated_at)
     VALUES (?, 'owner', 'not-used', 'UTC', 1, ?, ?)`,
  ).run(USER_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO lists (id, user_id, name, sort_key, is_inbox, rev, created_at, updated_at)
     VALUES (?, ?, 'Inbox', 'V00000000000000', 1, 1, ?, ?)`,
  ).run(LIST_ID, USER_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO tasks
       (id, user_id, list_id, title, status, priority, due_at, all_day,
        occurrence_seq, recurrence_mode, clamp_policy, missed_count,
        sort_key, rev, created_at, updated_at)
     VALUES (?, ?, ?, 'Milk', 'open', 0, '2026-11-03T09:00:00.000Z', 0,
       0, 'schedule', 'skip', 0, 'V001', 1, ?, ?)`,
  ).run(TASK_ID, USER_ID, LIST_ID, NOW, NOW);
  return database;
}

function taskRow(database: MorrowDatabase, id = TASK_ID) {
  return database.sqlite
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(id) as Record<string, unknown>;
}

function toolContext(database: MorrowDatabase): McpToolContext {
  return {
    store: new TaskStore(database.sqlite),
    quotas: new QuotaTracker(),
    auth: { tokenId: "primary", scopes: ["read", "write", "propose"] },
    sessionId: "opencode-session-undo",
    actorId: "assistant",
    now: new Date(NOW),
  };
}

function insertRawActivity(
  database: MorrowDatabase,
  opts: {
    batchId: string;
    action: string;
    entityId: string;
    beforeJson: string;
    afterJson: string;
  },
): void {
  database.sqlite
    .prepare(
      `INSERT INTO activity
         (batch_id, op_id, actor, actor_id, action, entity_type, entity_id,
          before_json, after_json, summary, created_at)
       VALUES (?, NULL, 'user', ?, ?, 'task', ?, ?, ?, 'hostile snapshot', ?)`,
    )
    .run(
      opts.batchId,
      USER_ID,
      opts.action,
      opts.entityId,
      opts.beforeJson,
      opts.afterJson,
      NOW,
    );
}

describe("agent undo snapshot validation", () => {
  it("rejects a hostile before_json key without executing SQL", () => {
    const database = seed();
    try {
      const store = new TaskStore(database.sqlite);
      const before = taskRow(database);
      database.sqlite
        .prepare("UPDATE tasks SET title = 'Silk', rev = 2, updated_at = ? WHERE id = ?")
        .run(NOW, TASK_ID);
      const after = taskRow(database);
      const batchId = newId();
      insertRawActivity(database, {
        batchId,
        action: "task.update",
        entityId: TASK_ID,
        beforeJson: JSON.stringify({
          task: {
            ...before,
            'notes" = (SELECT sqlite_version()) --': "exfiltrated",
          },
          completion: null,
        }),
        afterJson: JSON.stringify({ task: after, completion: null }),
      });

      expect(() => undoActivityBatch(store, batchId, USER_ID)).toThrow(
        expect.objectContaining({ code: "invalid_snapshot" }),
      );
      const current = taskRow(database);
      expect(current["title"]).toBe("Silk");
      expect(current["rev"]).toBe(2);
      expect(Object.keys(current)).not.toContain(
        'notes" = (SELECT sqlite_version()) --',
      );
      const tables = database.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).not.toContain("exfiltrated");
    } finally {
      database.close();
    }
  });

  it("rejects unknown envelope keys and snapshots for another task", () => {
    const database = seed();
    try {
      const store = new TaskStore(database.sqlite);
      const before = taskRow(database);

      const extraKeyBatch = newId();
      insertRawActivity(database, {
        batchId: extraKeyBatch,
        action: "task.update",
        entityId: TASK_ID,
        beforeJson: JSON.stringify({
          task: before,
          completion: null,
          unexpected: true,
        }),
        afterJson: JSON.stringify({ task: before, completion: null }),
      });
      expect(() => undoActivityBatch(store, extraKeyBatch, USER_ID)).toThrow(
        expect.objectContaining({ code: "invalid_snapshot" }),
      );

      const otherId = "01900000-0000-7000-8000-000000000004";
      database.sqlite
        .prepare(
          `INSERT INTO tasks
             (id, user_id, list_id, title, status, priority, all_day,
              occurrence_seq, recurrence_mode, clamp_policy, missed_count,
              sort_key, rev, created_at, updated_at)
           VALUES (?, ?, ?, 'Other', 'open', 0, 0, 0, 'schedule', 'skip', 0,
             'V002', 1, ?, ?)`,
        )
        .run(otherId, USER_ID, LIST_ID, NOW, NOW);
      const wrongIdBatch = newId();
      insertRawActivity(database, {
        batchId: wrongIdBatch,
        action: "task.update",
        entityId: TASK_ID,
        beforeJson: JSON.stringify({
          task: taskRow(database, otherId),
          completion: null,
        }),
        afterJson: JSON.stringify({ task: before, completion: null }),
      });
      expect(() => undoActivityBatch(store, wrongIdBatch, USER_ID)).toThrow(
        expect.objectContaining({ code: "invalid_snapshot" }),
      );
      expect(taskRow(database, otherId)["title"]).toBe("Other");
      expect(taskRow(database)["title"]).toBe("Milk");
    } finally {
      database.close();
    }
  });
});

describe("agent batch completion undo", () => {
  it("undoes a one-shot completion and allows completing again", async () => {
    const database = seed();
    try {
      const ctx = toolContext(database);
      const first = await callTool(ctx, "reminders_complete", {
        taskId: TASK_ID,
        baseRev: 1,
      });
      expect(first.ok).toBe(true);
      const batchId = (first.data as { undo: { batchId: string } }).undo
        .batchId;
      expect(taskRow(database)["status"]).toBe("done");

      const undone = undoActivityBatch(ctx.store, batchId, USER_ID);
      expect(undone.undone).toBe(1);
      const reopened = taskRow(database);
      expect(reopened["status"]).toBe("open");
      expect(reopened["completed_at"]).toBeNull();
      const completions = database.sqlite
        .prepare("SELECT deleted_at FROM task_completions WHERE task_id = ?")
        .all(TASK_ID) as Array<{ deleted_at: string | null }>;
      expect(completions).toHaveLength(1);
      expect(completions[0]?.deleted_at).not.toBeNull();

      const again = await callTool(ctx, "reminders_complete", {
        taskId: TASK_ID,
        baseRev: Number(reopened["rev"]),
      });
      expect(again.ok).toBe(true);
      const live = database.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ? AND deleted_at IS NULL",
        )
        .get(TASK_ID) as { n: number };
      expect(live.n).toBe(1);
      expect(taskRow(database)["status"]).toBe("done");
    } finally {
      database.close();
    }
  });

  it("undoes a recurring completion checkpoint and allows completing again", async () => {
    const database = seed();
    try {
      const recurringId = "01900000-0000-7000-8000-000000000005";
      database.sqlite
        .prepare(
          `INSERT INTO tasks
             (id, user_id, list_id, title, status, priority, due_at, all_day,
              timezone, dtstart_local, next_occurrence_at, next_occurrence_local,
              occurrence_seq, rrule, recurrence_mode, clamp_policy, missed_count,
              sort_key, rev, created_at, updated_at)
           VALUES (?, ?, ?, 'Daily standup', 'open', 0,
             '2026-11-02T09:00:00.000Z', 0, 'UTC', '2026-11-02T09:00:00',
             '2026-11-02T09:00:00.000Z', '2026-11-02T09:00:00', 0,
             'FREQ=DAILY', 'schedule', 'skip', 0, 'V003', 1, ?, ?)`,
        )
        .run(recurringId, USER_ID, LIST_ID, NOW, NOW);
      const ctx = toolContext(database);
      const first = await callTool(ctx, "reminders_complete", {
        taskId: recurringId,
        baseRev: 1,
      });
      expect(first.ok).toBe(true);
      const batchId = (first.data as { undo: { batchId: string } }).undo
        .batchId;
      const completed = taskRow(database, recurringId);
      expect(completed["next_occurrence_at"]).toBe(
        "2026-11-03T09:00:00.000Z",
      );

      undoActivityBatch(ctx.store, batchId, USER_ID);
      const reopened = taskRow(database, recurringId);
      expect(reopened["status"]).toBe("open");
      expect(reopened["next_occurrence_at"]).toBe(
        "2026-11-02T09:00:00.000Z",
      );
      expect(reopened["occurrence_seq"]).toBe(0);
      const live = database.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ? AND deleted_at IS NULL",
        )
        .get(recurringId) as { n: number };
      expect(live.n).toBe(0);

      const again = await callTool(ctx, "reminders_complete", {
        taskId: recurringId,
        baseRev: Number(reopened["rev"]),
      });
      expect(again.ok).toBe(true);
      expect(taskRow(database, recurringId)["next_occurrence_at"]).toBe(
        "2026-11-03T09:00:00.000Z",
      );
      const liveAfter = database.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ? AND deleted_at IS NULL",
        )
        .get(recurringId) as { n: number };
      expect(liveAfter.n).toBe(1);
    } finally {
      database.close();
    }
  });

  it("undoes a one-shot skip and allows skipping again", async () => {
    const database = seed();
    try {
      const ctx = toolContext(database);
      const first = await callTool(ctx, "reminders_skip", {
        taskId: TASK_ID,
        baseRev: 1,
      });
      expect(first.ok).toBe(true);
      const batchId = (first.data as { undo: { batchId: string } }).undo
        .batchId;
      expect(taskRow(database)["status"]).toBe("cancelled");

      undoActivityBatch(ctx.store, batchId, USER_ID);
      const reopened = taskRow(database);
      expect(reopened["status"]).toBe("open");
      const live = database.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ? AND deleted_at IS NULL",
        )
        .get(TASK_ID) as { n: number };
      expect(live.n).toBe(0);

      const again = await callTool(ctx, "reminders_skip", {
        taskId: TASK_ID,
        baseRev: Number(reopened["rev"]),
      });
      expect(again.ok).toBe(true);
      expect(taskRow(database)["status"]).toBe("cancelled");
      const liveAfter = database.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM task_completions WHERE task_id = ? AND deleted_at IS NULL",
        )
        .get(TASK_ID) as { n: number };
      expect(liveAfter.n).toBe(1);
    } finally {
      database.close();
    }
  });
});
