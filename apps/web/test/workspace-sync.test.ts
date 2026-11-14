import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { MemoryStorage } from "./helpers.js";
import {
  readWorkspaceStamp,
  writeWorkspaceStamp,
} from "@/lib/workspace-state";
import { reconcileWorkspaceState } from "@/lib/workspace-sync";

const storageMocks = vi.hoisted(() => ({
  clearLocalTaskState: vi.fn(),
}));

vi.mock("@/lib/storage", () => ({
  clearLocalTaskState: storageMocks.clearLocalTaskState,
}));

describe("workspace reconciliation", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    storageMocks.clearLocalTaskState.mockReset();
    storageMocks.clearLocalTaskState.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adopts a first-run stamp without clearing local state", async () => {
    vi.spyOn(api, "workspaceState").mockResolvedValue({
      user: { id: "user-1" },
      workspaceEpoch: 3,
    });

    await expect(reconcileWorkspaceState(storage)).resolves.toBe(false);
    expect(storageMocks.clearLocalTaskState).not.toHaveBeenCalled();
    expect(readWorkspaceStamp(storage)).toEqual({
      userId: "user-1",
      epoch: 3,
    });
  });

  it("keeps state for the same owner and epoch", async () => {
    writeWorkspaceStamp({ userId: "user-1", epoch: 3 }, storage);
    vi.spyOn(api, "workspaceState").mockResolvedValue({
      user: { id: "user-1" },
      workspaceEpoch: 3,
    });

    await expect(reconcileWorkspaceState(storage)).resolves.toBe(false);
    expect(storageMocks.clearLocalTaskState).not.toHaveBeenCalled();
  });

  it("clears queued state when the workspace epoch changes", async () => {
    writeWorkspaceStamp({ userId: "user-1", epoch: 2 }, storage);
    vi.spyOn(api, "workspaceState").mockResolvedValue({
      user: { id: "user-1" },
      workspaceEpoch: 3,
    });

    await expect(reconcileWorkspaceState(storage)).resolves.toBe(true);
    expect(storageMocks.clearLocalTaskState).toHaveBeenCalledTimes(1);
    expect(readWorkspaceStamp(storage)).toEqual({
      userId: "user-1",
      epoch: 3,
    });
  });

  it("clears queued state when the owner changes", async () => {
    writeWorkspaceStamp({ userId: "user-1", epoch: 3 }, storage);
    vi.spyOn(api, "workspaceState").mockResolvedValue({
      user: { id: "user-2" },
      workspaceEpoch: 3,
    });

    await expect(reconcileWorkspaceState(storage)).resolves.toBe(true);
    expect(storageMocks.clearLocalTaskState).toHaveBeenCalledTimes(1);
    expect(readWorkspaceStamp(storage)).toEqual({
      userId: "user-2",
      epoch: 3,
    });
  });

  it("leaves the old stamp when the purge fails so the next launch retries", async () => {
    writeWorkspaceStamp({ userId: "user-1", epoch: 2 }, storage);
    vi.spyOn(api, "workspaceState").mockResolvedValue({
      user: { id: "user-1" },
      workspaceEpoch: 3,
    });
    storageMocks.clearLocalTaskState.mockRejectedValueOnce(
      new Error("database blocked"),
    );

    await expect(reconcileWorkspaceState(storage)).resolves.toBe(false);
    expect(readWorkspaceStamp(storage)).toEqual({
      userId: "user-1",
      epoch: 2,
    });
  });

  it("does not clear anything when the probe fails", async () => {
    writeWorkspaceStamp({ userId: "user-1", epoch: 2 }, storage);
    vi.spyOn(api, "workspaceState").mockRejectedValue(new Error("offline"));

    await expect(reconcileWorkspaceState(storage)).resolves.toBe(false);
    expect(storageMocks.clearLocalTaskState).not.toHaveBeenCalled();
    expect(readWorkspaceStamp(storage)).toEqual({
      userId: "user-1",
      epoch: 2,
    });
  });
});
