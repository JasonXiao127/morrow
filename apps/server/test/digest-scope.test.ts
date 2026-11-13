/**
 * Morning/weekly briefs are owner-scoped. This regression test pins the
 * isolation rule from plan §0.1: the owner's brief must not count or print a
 * member's private task titles.
 */
import { describe, expect, it } from "vitest";
import { openDatabase } from "@morrow/db";
import { maybeSendDigests } from "../src/digests.js";

const OWNER_ID = "01900000-0000-7000-8000-000000000101";
const MEMBER_ID = "01900000-0000-7000-8000-000000000102";
const NOW = "2026-11-08T09:00:00.000Z";

function addUser(
  database: ReturnType<typeof openDatabase>,
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

function addTask(
  database: ReturnType<typeof openDatabase>,
  id: string,
  userId: string,
  title: string,
): void {
  database.sqlite
    .prepare(
      `INSERT INTO tasks
         (id, user_id, title, status, priority, all_day, timezone, due_date,
          recurrence_mode, clamp_policy, missed_count, occurrence_seq,
          created_at, updated_at)
       VALUES (?, ?, ?, 'open', 1, 1, 'UTC', '2026-11-08',
               'schedule', 'skip', 0, 0, ?, ?)`,
    )
    .run(id, userId, title, NOW, NOW);
}

function addSetting(
  database: ReturnType<typeof openDatabase>,
  key: string,
  value: unknown,
): void {
  database.sqlite
    .prepare(
      `INSERT INTO settings (key, value, rev, updated_at) VALUES (?, ?, 1, ?)`,
    )
    .run(key, JSON.stringify(value), NOW);
}

describe("digest account scoping", () => {
  it("summarizes only the owner's accessible tasks", async () => {
    const database = openDatabase({ path: ":memory:" });
    try {
      addUser(database, OWNER_ID, "owner", "owner");
      addUser(database, MEMBER_ID, "member", "member");
      addTask(database, "task-owner", OWNER_ID, "Owner digest task");
      addTask(database, "task-member", MEMBER_ID, "Member private digest task");
      addSetting(database, "digest", {
        morning: { enabled: true, time: "00:00" },
        weekly: { enabled: false, day: 1, time: "08:00" },
      });
      // A configured ntfy channel makes canSend() true without requiring a
      // real push subscription. The private-host check fails fast in sendNtfy,
      // so this test never touches the network.
      addSetting(database, "ntfy", {
        enabled: true,
        url: "https://127.0.0.1",
        topic: "digest-scope-test",
      });

      const result = await maybeSendDigests(database.sqlite, new Date(NOW));
      expect(result.morning).toBe(true);

      const row = database.sqlite
        .prepare(
          `SELECT after_json FROM activity
            WHERE action = 'brief.morning'
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { after_json: string } | undefined;
      expect(row).toBeDefined();
      const body = (JSON.parse(row!.after_json) as { body: string }).body;
      expect(body).toContain("Owner digest task");
      expect(body).not.toContain("Member private digest task");
      expect(body).toContain("1 due today");
    } finally {
      database.close();
    }
  });
});
