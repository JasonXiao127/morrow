import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONFLICT_EVENT,
  reportConflict,
  subscribeConflict,
  type ConflictReport,
} from "../src/lib/conflict.js";
import { fakeWindow } from "./helpers.js";

describe("conflict event bus", () => {
  beforeEach(() => {
    vi.stubGlobal("window", fakeWindow());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers the full report, including resolver callbacks", () => {
    const received: ConflictReport[] = [];
    const unsubscribe = subscribeConflict((report) => received.push(report));
    const reload = vi.fn(async () => undefined);
    const overwrite = vi.fn(async () => undefined);

    reportConflict({
      kind: "stale",
      title: "This changed elsewhere",
      message: "Reload before saving.",
      detail: "rev 4 → rev 5",
      taskTitle: "Buy milk",
      currentTask: { id: "task-1", title: "Buy milk", rev: 5 },
      reload,
      overwrite,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: "stale",
      title: "This changed elsewhere",
      detail: "rev 4 → rev 5",
      taskTitle: "Buy milk",
      currentTask: { id: "task-1", rev: 5 },
    });
    expect(received[0]?.reload).toBe(reload);
    expect(received[0]?.overwrite).toBe(overwrite);

    void received[0]?.reload?.();
    expect(reload).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    const handler = vi.fn();
    const unsubscribe = subscribeConflict(handler);

    reportConflict({ kind: "sync" });
    unsubscribe();
    reportConflict({ kind: "missing-revision" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ kind: "sync" });
  });

  it("supports multiple subscribers and ignores events without detail", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = subscribeConflict(first);
    const offSecond = subscribeConflict(second);

    window.dispatchEvent(new Event(CONFLICT_EVENT));
    reportConflict({ kind: "semantic", message: "No longer valid." });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith({
      kind: "semantic",
      message: "No longer valid.",
    });
    offFirst();
    offSecond();
  });

  it("is a no-op without a window, so server/prerender paths stay safe", () => {
    vi.stubGlobal("window", undefined);
    expect(() => reportConflict({ kind: "sync" })).not.toThrow();
  });
});
