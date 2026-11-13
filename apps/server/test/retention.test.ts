import { describe, expect, it } from "vitest";
import { openDatabase } from "@morrow/db";
import {
  recordActivity,
  type ActivityDb,
} from "../src/activity.js";
import type { BackupDb } from "../src/backup.js";
import { runRetention } from "../src/retention.js";
import {
  SEED_NOW,
  SEED_TASK_ID,
  SEED_USER_ID,
  seedSecretsDb,
} from "./helpers.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const OLD = "2026-01-01T00:00:00.000Z";
const RECENT = "2026-11-01T00:00:00.000Z";

describe("operational retention", () => {
  it("prunes old logs, keeps recent rows, and never touches core data", () => {
    const { sqlite, close } = openDatabase({ path: ":memory:" });
    try {
      seedSecretsDb(sqlite as unknown as BackupDb);
      sqlite
        .prepare(
          `INSERT INTO agent_conversations
             (id, user_id, title, created_at, updated_at)
           VALUES ('conv-1', ?, 'Chat', ?, ?)`,
        )
        .run(SEED_USER_ID, SEED_NOW, SEED_NOW);

      const insertDelivery = sqlite.prepare(
        `INSERT INTO deliveries
           (id, task_id, occurrence_key, kind, channel, status, created_at, updated_at)
         VALUES (?, ?, ?, 'reminder', 'webpush', ?, ?, ?)`,
      );
      insertDelivery.run(
        "d-old-sent",
        SEED_TASK_ID,
        "occ-old-sent",
        "sent",
        OLD,
        OLD,
      );
      insertDelivery.run(
        "d-old-pending",
        SEED_TASK_ID,
        "occ-old-pending",
        "pending",
        OLD,
        OLD,
      );
      insertDelivery.run(
        "d-recent-sent",
        SEED_TASK_ID,
        "occ-recent-sent",
        "sent",
        RECENT,
        RECENT,
      );

      const insertOperation = sqlite.prepare(
        `INSERT INTO operations (op_id, kind, result_json, created_at)
         VALUES (?, 'task.create', '{}', ?)`,
      );
      insertOperation.run("op-old", OLD);
      insertOperation.run("op-recent", RECENT);

      const insertMessage = sqlite.prepare(
        `INSERT INTO agent_messages
           (id, conversation_id, role, content, created_at)
         VALUES (?, 'conv-1', 'user', ?, ?)`,
      );
      insertMessage.run("msg-old", "old", OLD);
      insertMessage.run("msg-recent", "recent", RECENT);

      const insertProposal = sqlite.prepare(
        `INSERT INTO proposals
           (id, conversation_id, summary, operations_json, payload_hash,
            expires_at, status, created_at, updated_at)
         VALUES (?, 'conv-1', 'p', '[]', 'hash', ?, ?, ?, ?)`,
      );
      insertProposal.run("p-old-expired", OLD, "expired", OLD, OLD);
      insertProposal.run("p-old-pending", OLD, "pending", OLD, OLD);
      insertProposal.run(
        "p-recent-expired",
        RECENT,
        "expired",
        RECENT,
        RECENT,
      );

      sqlite
        .prepare(
          `INSERT INTO sessions
             (id, user_id, token_hash, created_at, last_seen_at,
              expires_at, absolute_expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("s-old-expired", SEED_USER_ID, "hash-old-expired", OLD, OLD, OLD, OLD);
      sqlite
        .prepare(
          `INSERT INTO sessions
             (id, user_id, token_hash, created_at, last_seen_at,
              expires_at, absolute_expires_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "s-old-revoked",
          SEED_USER_ID,
          "hash-old-revoked",
          OLD,
          OLD,
          RECENT,
          RECENT,
          RECENT,
        );

      const activityDb = sqlite as unknown as ActivityDb;
      recordActivity(activityDb, {
        actor: "user",
        actorId: SEED_USER_ID,
        action: "task.create",
        entityType: "task",
        entityId: SEED_TASK_ID,
        createdAt: OLD,
      });
      recordActivity(activityDb, {
        actor: "user",
        actorId: SEED_USER_ID,
        action: "task.update",
        entityType: "task",
        entityId: SEED_TASK_ID,
        createdAt: RECENT,
      });

      const counts = runRetention(sqlite, {
        now: NOW,
        activityRetentionDays: 90,
      });
      expect(counts).toEqual({
        activity: 1,
        deliveries: 1,
        operations: 1,
        agentMessages: 1,
        proposals: 1,
        sessions: 2,
      });

      // Core data and the seeded owner/list/task survive.
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({
        n: 1,
      });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({
        n: 1,
      });
      expect(
        sqlite.prepare("SELECT COUNT(*) AS n FROM deliveries").get(),
      ).toEqual({ n: 2 });
      expect(
        sqlite.prepare("SELECT COUNT(*) AS n FROM operations").get(),
      ).toEqual({ n: 1 });
      expect(
        sqlite.prepare("SELECT COUNT(*) AS n FROM agent_messages").get(),
      ).toEqual({ n: 1 });
      expect(
        sqlite.prepare("SELECT COUNT(*) AS n FROM proposals").get(),
      ).toEqual({ n: 2 });
      expect(
        sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get(),
      ).toEqual({ n: 1 });
    } finally {
      close();
    }
  });
});
