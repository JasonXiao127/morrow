import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./helpers.js";
import {
  clearWorkspaceStamp,
  evaluateWorkspaceStamp,
  readWorkspaceStamp,
  writeWorkspaceStamp,
} from "@/lib/workspace-state";

describe("workspace stamp", () => {
  it("treats a missing stamp as a first run without a reset", () => {
    expect(
      evaluateWorkspaceStamp(null, { userId: "user-1", epoch: 1 }),
    ).toEqual({ reset: false, reason: "first" });
  });

  it("keeps the same owner and epoch", () => {
    expect(
      evaluateWorkspaceStamp(
        { userId: "user-1", epoch: 4 },
        { userId: "user-1", epoch: 4 },
      ),
    ).toEqual({ reset: false, reason: "same" });
  });

  it("resets when the owner changes", () => {
    expect(
      evaluateWorkspaceStamp(
        { userId: "user-1", epoch: 4 },
        { userId: "user-2", epoch: 4 },
      ),
    ).toEqual({ reset: true, reason: "user" });
  });

  it("resets when the restore epoch changes", () => {
    expect(
      evaluateWorkspaceStamp(
        { userId: "user-1", epoch: 4 },
        { userId: "user-1", epoch: 5 },
      ),
    ).toEqual({ reset: true, reason: "epoch" });
  });

  it("reads and writes a valid stamp", () => {
    const storage = new MemoryStorage();
    writeWorkspaceStamp({ userId: "user-1", epoch: 2 }, storage);
    expect(readWorkspaceStamp(storage)).toEqual({
      userId: "user-1",
      epoch: 2,
    });
    clearWorkspaceStamp(storage);
    expect(readWorkspaceStamp(storage)).toBeNull();
  });

  it("ignores corrupt or partial storage", () => {
    const storage = new MemoryStorage();
    storage.setItem("morrow.ownerId", "user-1");
    storage.setItem("morrow.workspaceEpoch", "not-a-number");
    expect(readWorkspaceStamp(storage)).toBeNull();
  });
});
