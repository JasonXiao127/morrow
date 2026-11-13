import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api";
import { subscribeConflict, type ConflictReport } from "../src/lib/conflict.js";
import {
  clearUndo,
  peekUndo,
  pushUndo,
  undoLast,
} from "../src/lib/undo.js";
import { MemoryStorage, fakeWindow } from "./helpers.js";

const mocks = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  });
  return {
    toast,
    announce: vi.fn(),
    invalidate: vi.fn(),
    getQueryData: vi.fn(),
    activityUndo: vi.fn(),
    activityUndoLatest: vi.fn(),
  };
});

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("@/lib/announce", () => ({ announce: mocks.announce }));

vi.mock("@/lib/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query")>();
  return {
    ...actual,
    queryClient: { getQueryData: mocks.getQueryData },
    invalidateTaskQueries: mocks.invalidate,
  };
});

vi.mock("@/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api")>();
  return {
    ...actual,
    activityApi: {
      undo: mocks.activityUndo,
      undoLatest: mocks.activityUndoLatest,
    },
  };
});

describe("undo stack", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    mocks.activityUndo.mockReset();
    mocks.activityUndoLatest.mockReset();
    mocks.invalidate.mockReset().mockResolvedValue(undefined);
    mocks.getQueryData.mockReset();
    mocks.announce.mockReset();
    mocks.toast.mockReset();
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();

    const win = fakeWindow();
    storage = win.sessionStorage as MemoryStorage;
    vi.stubGlobal("window", win);
    clearUndo();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers entries newest-first and persists only serializable fields", () => {
    pushUndo({ label: "Completed task" });
    pushUndo({ label: "Snoozed task", activityId: 12, entityId: "task-1" });

    expect(peekUndo()).toMatchObject({
      label: "Snoozed task",
      activityId: 12,
      entityId: "task-1",
    });

    const stored = JSON.parse(
      storage.getItem("morrow.undo.v1") ?? "[]",
    ) as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      label: "Snoozed task",
      activityId: 12,
      entityId: "task-1",
    });
    expect(stored[0]?.id).toMatch(/^undo-/);
    expect(stored[0]).not.toHaveProperty("fallback");
  });

  it("caps the stack at 20 entries", () => {
    for (let index = 0; index < 25; index += 1) {
      pushUndo({ label: `Action ${index}` });
    }

    const stored = JSON.parse(
      storage.getItem("morrow.undo.v1") ?? "[]",
    ) as Array<{ label: string }>;
    expect(stored).toHaveLength(20);
    expect(stored[0]?.label).toBe("Action 24");
    expect(stored[19]?.label).toBe("Action 5");
    expect(peekUndo()?.label).toBe("Action 24");
  });

  it("clears the in-memory and persisted stack", () => {
    pushUndo({ label: "Completed task" });
    clearUndo();

    expect(peekUndo()).toBeUndefined();
    expect(storage.getItem("morrow.undo.v1")).toBe("[]");
  });

  it("explains an empty stack instead of calling the API", async () => {
    await expect(undoLast()).resolves.toBe(false);

    expect(mocks.toast).toHaveBeenCalledWith(
      "Nothing to undo",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(mocks.activityUndo).not.toHaveBeenCalled();
  });

  it("undoes by activity id, then invalidates and removes the entry", async () => {
    mocks.activityUndo.mockResolvedValue({});
    pushUndo({ label: "Archived task", activityId: 42 });

    await expect(undoLast()).resolves.toBe(true);

    expect(mocks.activityUndo).toHaveBeenCalledWith(42);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(mocks.announce).toHaveBeenCalledWith("Undid Archived task.");
    expect(mocks.toast.success).toHaveBeenCalledWith("Undid Archived task");
    expect(peekUndo()).toBeUndefined();
  });

  it("looks up the latest activity row when an activity id is unavailable", async () => {
    mocks.getQueryData.mockReturnValue({
      lists: [],
      tasks: [],
      cursor: 100,
    });
    mocks.activityUndoLatest.mockResolvedValue(77);
    pushUndo({
      label: "Completed task",
      entityId: "task-9",
      action: "complete",
    });

    await expect(undoLast()).resolves.toBe(true);

    expect(mocks.activityUndoLatest).toHaveBeenCalledWith({
      entityId: "task-9",
      action: "complete",
      fromCursor: 70,
    });
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(peekUndo()).toBeUndefined();
  });

  it("falls back locally when activity history is missing", async () => {
    mocks.activityUndo.mockRejectedValue(
      new ApiError(404, null, "Activity history is unavailable."),
    );
    mocks.getQueryData.mockReturnValue({ lists: [], tasks: [], cursor: 5 });
    mocks.activityUndoLatest.mockResolvedValue(null);
    const fallback = vi.fn(async () => undefined);
    pushUndo({
      label: "Renamed task",
      activityId: 4,
      entityId: "task-2",
      action: "update",
      fallback,
    });

    await expect(undoLast()).resolves.toBe(true);

    expect(mocks.activityUndoLatest).toHaveBeenCalledWith({
      entityId: "task-2",
      action: "update",
      fromCursor: 0,
    });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenCalledWith("Undid Renamed task");
    expect(peekUndo()).toBeUndefined();
  });

  it("runs a registration fallback when there is no server action", async () => {
    const fallback = vi.fn(async () => undefined);
    pushUndo({ label: "Snoozed task", fallback });

    await expect(undoLast()).resolves.toBe(true);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(peekUndo()).toBeUndefined();
  });

  it("reports a stale conflict when a fallback loses a revision race", async () => {
    const reports: ConflictReport[] = [];
    const unsubscribe = subscribeConflict((report) => reports.push(report));
    const fallback = vi
      .fn()
      .mockRejectedValue(new ApiError(409, { detail: "stale" }, "stale"));
    pushUndo({ label: "Snoozed task", fallback });

    await expect(undoLast()).resolves.toBe(false);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      kind: "stale",
      title: "Undo needs a fresh copy",
    });
    expect(reports[0]?.message).toContain("changed after the action");
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(peekUndo()?.label).toBe("Snoozed task");

    await reports[0]?.reload?.();
    expect(mocks.invalidate).toHaveBeenCalled();
    unsubscribe();
  });

  it("keeps the entry and explains when no local inverse is safe", async () => {
    pushUndo({ label: "Completed recurring task" });

    await expect(undoLast()).resolves.toBe(false);

    expect(mocks.toast).toHaveBeenCalledWith(
      "Undo isn’t available locally for that change",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(peekUndo()?.label).toBe("Completed recurring task");
  });

  it("surfaces a non-conflict fallback failure and keeps the entry", async () => {
    const fallback = vi
      .fn()
      .mockRejectedValue(
        new ApiError(500, { detail: "server exploded" }, "server"),
      );
    pushUndo({ label: "Deleted task", fallback });

    await expect(undoLast()).resolves.toBe(false);

    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Morrow hit a problem. Your data is safe; try again.",
    );
    expect(peekUndo()?.label).toBe("Deleted task");
  });
});
