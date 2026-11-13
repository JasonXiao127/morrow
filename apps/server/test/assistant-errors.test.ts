import { openDatabase } from "@morrow/db";
import { describe, expect, it } from "vitest";
import { mapOpenCodeEvent, TaskStore } from "@morrow/agent";

function seedUser(sqlite: ReturnType<typeof openDatabase>["sqlite"]): TaskStore {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      "INSERT INTO users (id, username, password_hash, timezone, rev, created_at, updated_at) VALUES ('u1','owner','h','UTC',1,?,?)",
    )
    .run(now, now);
  return new TaskStore(sqlite as never);
}

describe("assistant run error persistence (harness step 1)", () => {
  it("persists a provider 429 and clears it on success", () => {
    const { sqlite, close } = openDatabase({ path: ":memory:" });
    try {
      const store = seedUser(sqlite);
      const conv = store.createConversation("t");
      expect(store.getConversation(conv.id)?.lastError).toBeNull();

      const event = mapOpenCodeEvent({
        type: "session.execution.failed",
        data: {
          sessionID: "ses_1",
          error: {
            type: "provider.free-limit",
            message: "Free usage limit reached. Connect a provider or switch models.",
            status: 429,
          },
        },
      });
      expect(event?.data["code"]).toBe("provider.free-limit");
      store.setConversationError(conv.id, {
        code: typeof event?.data["code"] === "string" ? event.data["code"] : null,
        message: String(event?.data["message"]),
      });

      const failed = store.getConversation(conv.id);
      expect(failed?.lastError?.message).toContain("Free usage limit");
      expect(failed?.lastError?.code).toBe("provider.free-limit");
      expect(failed?.lastError?.at).toBeTruthy();

      store.clearConversationError(conv.id);
      expect(store.getConversation(conv.id)?.lastError).toBeNull();
    } finally {
      close();
    }
  });
});
