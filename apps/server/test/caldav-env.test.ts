/**
 * Deprecated CALDAV_TOKEN fallback must resolve the workspace owner, not the
 * earliest-created account (Round 3). A per-user `kind=caldav` token remains
 * the preferred path.
 */
import { describe, expect, it } from "vitest";
import { openDatabase } from "@morrow/db";
import { caldavEnvFallbackUser } from "../src/caldav.js";

const NOW = "2026-11-02T12:00:00.000Z";

describe("CALDAV_TOKEN env fallback", () => {
  it("maps only the owner even when a member was created first", () => {
    const database = openDatabase({ path: ":memory:" });
    try {
      database.sqlite
        .prepare(
          `INSERT INTO users (id, username, password_hash, role, timezone, created_at, updated_at)
           VALUES ('member-first', 'member-first', 'x', 'member', 'UTC', ?, ?),
                  ('real-owner', 'real-owner', 'x', 'owner', 'UTC', ?, ?)`,
        )
        .run(NOW, NOW, "2026-11-03T00:00:00.000Z", "2026-11-03T00:00:00.000Z");

      const user = caldavEnvFallbackUser(database.sqlite);
      expect(user?.id).toBe("real-owner");
      expect(user?.username).toBe("real-owner");
    } finally {
      database.close();
    }
  });

  it("returns null when there is no owner", () => {
    const database = openDatabase({ path: ":memory:" });
    try {
      database.sqlite
        .prepare(
          `INSERT INTO users (id, username, password_hash, role, timezone, created_at, updated_at)
           VALUES ('member-only', 'member-only', 'x', 'member', 'UTC', ?, ?)`,
        )
        .run(NOW, NOW);
      expect(caldavEnvFallbackUser(database.sqlite)).toBeNull();
    } finally {
      database.close();
    }
  });
});
