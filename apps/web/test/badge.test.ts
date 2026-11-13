import { describe, expect, it } from "vitest";
import { dueBadgeCount } from "@/lib/badge";
import { todayKey } from "@/lib/format";
import { makeTask } from "./helpers.js";

describe("app badge count", () => {
  it("counts open tasks due today or overdue", () => {
    expect(
      dueBadgeCount([
        makeTask({ id: "today", dueDate: todayKey() }),
        makeTask({ id: "overdue", dueDate: "2020-01-01" }),
        makeTask({ id: "future", dueDate: "2999-01-01" }),
        makeTask({ id: "done", dueDate: todayKey(), status: "done" }),
      ]),
    ).toBe(2);
  });

  it("counts in the account timezone, not the browser zone", () => {
    const now = new Date("2026-11-09T04:30:00.000Z");
    const task = makeTask({ dueDate: "2026-11-09" });
    expect(dueBadgeCount([task], now, "America/New_York")).toBe(0);
    expect(dueBadgeCount([task], now, "UTC")).toBe(1);
  });

  it("excludes snoozed tasks until their snooze expires", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const today = todayKey(now);
    expect(
      dueBadgeCount(
        [
          makeTask({
            dueDate: today,
            snoozedUntil: "2026-07-15T13:00:00.000Z",
          }),
        ],
        now,
      ),
    ).toBe(0);
    expect(
      dueBadgeCount(
        [
          makeTask({
            dueDate: today,
            snoozedUntil: "2026-07-15T11:00:00.000Z",
          }),
        ],
        now,
      ),
    ).toBe(1);
  });
});
