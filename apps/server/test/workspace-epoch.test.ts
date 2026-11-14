import { describe, expect, it } from "vitest";
import { memBackupDb } from "./helpers.js";
import { invalidateRestoredCredentials } from "../src/restore.js";
import {
  bumpWorkspaceEpoch,
  readWorkspaceEpoch,
} from "../src/workspaceEpoch.js";

describe("workspace epoch", () => {
  it("reads a missing epoch as 0 and increments monotonically", () => {
    const handle = memBackupDb();
    try {
      expect(readWorkspaceEpoch(handle.db)).toBe(0);
      expect(bumpWorkspaceEpoch(handle.db)).toBe(1);
      expect(readWorkspaceEpoch(handle.db)).toBe(1);
      expect(bumpWorkspaceEpoch(handle.db)).toBe(2);
      expect(readWorkspaceEpoch(handle.db)).toBe(2);
    } finally {
      handle.close();
    }
  });

  it("bumps when restore invalidation runs", () => {
    const handle = memBackupDb();
    try {
      expect(readWorkspaceEpoch(handle.db)).toBe(0);
      invalidateRestoredCredentials(handle.db);
      expect(readWorkspaceEpoch(handle.db)).toBe(1);
    } finally {
      handle.close();
    }
  });
});
