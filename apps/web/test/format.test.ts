import { describe, expect, it } from "vitest";
import {
  addDays,
  dateKey,
  dateKeyInZone,
  formatGroupDate,
  formatLongDate,
  formatMonthYear,
  formatRelativeTime,
  formatShortDate,
  formatTaskDate,
  formatTimestamp,
  formatTime,
  groupTasksByDay,
  isCancelledTask,
  isDoneTask,
  isOpenTask,
  isPendingSyncTask,
  isTaskAfterToday,
  isTaskBeforeToday,
  isTaskDueToday,
  isTaskOverdue,
  isTaskSnoozed,
  listColorSlug,
  listDisplayName,
  parseDateKey,
  recurrenceLabel,
  sortTasks,
  startOfDay,
  taskDayKey,
  taskHasTime,
  taskInstant,
  taskList,
  taskOccurrenceKey,
  taskTimeLabel,
  todayKey,
  userDisplayName,
} from "../src/lib/format.js";
import { makeTask } from "./helpers.js";

const shortDate = (date: Date) =>
  new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
  }).format(date);
const shortTime = (date: Date) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

describe("date keys and day arithmetic", () => {
  it("round-trips local date keys and rejects malformed input", () => {
    const date = new Date(2026, 0, 5, 23, 59);
    expect(dateKey(date)).toBe("2026-01-05");
    expect(parseDateKey("2026-01-05")?.getFullYear()).toBe(2026);
    expect(parseDateKey("2026-01-05")?.getMonth()).toBe(0);
    expect(parseDateKey("2026-1-5")).toBeNull();
    expect(parseDateKey("nope")).toBeNull();
    expect(todayKey(date)).toBe("2026-01-05");
  });

  it("uses the browser-local day rather than the UTC day", () => {
    // In America/New_York this instant is still 2026-07-14.
    expect(dateKey(new Date("2026-07-15T02:00:00.000Z"))).toBe("2026-07-14");
  });

  it("adds days without mutating the input and zeroes the time", () => {
    const date = new Date(2026, 6, 15, 13, 45);
    expect(dateKey(addDays(date, -20))).toBe("2026-06-25");
    expect(dateKey(date)).toBe("2026-07-15");

    const start = startOfDay(date);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getDate()).toBe(15);
  });
});

describe("account timezone day keys", () => {
  it("resolves the same instant in different zones", () => {
    const instant = new Date("2026-11-09T04:30:00.000Z");
    expect(dateKeyInZone(instant, "UTC")).toBe("2026-11-09");
    expect(dateKeyInZone(instant, "America/New_York")).toBe("2026-11-08");
  });

  it("groups timed tasks in the account zone", () => {
    const late = makeTask({
      dueAt: "2026-11-09T04:30:00.000Z",
      allDay: false,
    });
    expect(taskDayKey(late, "America/New_York")).toBe("2026-11-08");
    expect(taskDayKey(late, "UTC")).toBe("2026-11-09");
  });

  it("compares today in the account zone", () => {
    const now = new Date("2026-11-09T04:30:00.000Z");
    const laterTodayUtc = makeTask({
      dueAt: "2026-11-09T15:00:00.000Z",
      allDay: false,
    });
    expect(isTaskDueToday(laterTodayUtc, now, "America/New_York")).toBe(false);
    expect(isTaskDueToday(laterTodayUtc, now, "UTC")).toBe(true);

    const allDay = makeTask({ dueDate: "2026-11-08", allDay: true });
    expect(isTaskDueToday(allDay, now, "America/New_York")).toBe(true);
    expect(isTaskDueToday(allDay, now, "UTC")).toBe(false);
  });

  it("groups and labels upcoming days in the account zone", () => {
    const now = new Date("2026-11-09T04:30:00.000Z");
    const late = makeTask({
      title: "Late",
      dueAt: "2026-11-09T04:30:00.000Z",
      allDay: false,
    });
    const groups = groupTasksByDay([late], "America/New_York");
    expect(groups[0]?.key).toBe("2026-11-08");
    expect(groups[0]?.tasks[0]?.title).toBe("Late");

    expect(formatGroupDate("2026-11-08", now, "America/New_York")).toBe(
      "Today",
    );
    expect(formatGroupDate("2026-11-09", now, "America/New_York")).toBe(
      "Tomorrow",
    );
    expect(formatGroupDate("2026-11-09", now, "UTC")).toBe("Today");
  });
});

describe("task day selection", () => {
  it("prefers the next all-day occurrence over the original DTSTART", () => {
    const allDay = makeTask({
      allDay: true,
      dueDate: "2026-07-10",
      nextOccurrenceLocal: "2026-07-17T00:00:00",
    });
    expect(taskDayKey(allDay)).toBe("2026-07-17");

    const timed = makeTask({
      dueAt: "2026-07-10T13:30:00.000Z",
      nextOccurrenceAt: "2026-07-17T13:30:00.000Z",
    });
    expect(taskDayKey(timed)).toBe("2026-07-17");

    expect(taskDayKey(makeTask())).toBeNull();
  });

  it("parses instants and exposes time labels", () => {
    const allDay = makeTask({
      allDay: true,
      dueDate: "2026-07-15",
      dueAt: "2026-07-15T13:30:00.000Z",
    });
    expect(dateKey(taskInstant(allDay) ?? new Date(0))).toBe("2026-07-15");
    expect(taskHasTime(allDay)).toBe(false);
    expect(taskTimeLabel(allDay)).toBe("All day");

    const timed = makeTask({ dueAt: "2026-07-15T13:30:00.000Z" });
    expect(taskHasTime(timed)).toBe(true);
    expect(taskTimeLabel(timed)).toBe(shortTime(new Date(timed.dueAt ?? "")));
    expect(taskTimeLabel(makeTask())).toBeNull();
  });

  it("recognises snoozes only while they are in the future", () => {
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    expect(
      isTaskSnoozed(
        makeTask({ snoozedUntil: "2026-07-15T12:01:00.000Z" }),
        now,
      ),
    ).toBe(true);
    expect(
      isTaskSnoozed(
        makeTask({ snoozedUntil: "2026-07-15T11:59:00.000Z" }),
        now,
      ),
    ).toBe(false);
    expect(
      isTaskSnoozed(makeTask({ snoozedUntil: "not-a-date" }), now),
    ).toBe(false);
    expect(isTaskSnoozed(makeTask(), now)).toBe(false);
  });

  it("detects overdue tasks but not done, cancelled, or snoozed ones", () => {
    const yesterday = dateKey(addDays(new Date(), -1));
    const overdue = makeTask({ allDay: true, dueDate: yesterday });
    expect(isTaskOverdue(overdue)).toBe(true);
    expect(isTaskOverdue({ ...overdue, status: "done" })).toBe(false);
    expect(isTaskOverdue({ ...overdue, status: "cancelled" })).toBe(false);
    expect(
      isTaskOverdue({
        ...overdue,
        snoozedUntil: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toBe(false);

    const timed = makeTask({
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(isTaskOverdue(timed)).toBe(true);
    expect(isTaskOverdue(makeTask())).toBe(false);
  });

  it("compares task days with a supplied now", () => {
    const now = new Date(2026, 6, 15, 12, 0);
    const today = makeTask({ allDay: true, dueDate: "2026-07-15" });
    expect(isTaskDueToday(today, now)).toBe(true);
    expect(isTaskBeforeToday(today, now)).toBe(false);
    expect(isTaskAfterToday(today, now)).toBe(false);

    expect(isTaskBeforeToday(makeTask({ allDay: true, dueDate: "2026-07-14" }), now)).toBe(true);
    expect(isTaskAfterToday(makeTask({ allDay: true, dueDate: "2026-07-16" }), now)).toBe(true);
    expect(isTaskDueToday(makeTask(), now)).toBe(false);
  });

  it("classifies status and pending-sync flags", () => {
    expect(isOpenTask(makeTask({ status: "open" }))).toBe(true);
    expect(isOpenTask(makeTask({ status: "done" }))).toBe(false);
    expect(isDoneTask(makeTask({ status: "done" }))).toBe(true);
    expect(isCancelledTask(makeTask({ status: "cancelled" }))).toBe(true);
    expect(isPendingSyncTask(makeTask({ pendingSync: true }))).toBe(true);
    expect(isPendingSyncTask(makeTask())).toBe(false);
  });
});

describe("sorting and grouping", () => {
  it("sorts by instant, then undated, done, and title", () => {
    const atNine = makeTask({
      id: "nine",
      title: "Zeta",
      dueAt: "2026-07-15T13:00:00.000Z",
    });
    const atTen = makeTask({
      id: "ten",
      title: "Alpha",
      dueAt: "2026-07-15T14:00:00.000Z",
    });
    expect([atTen, atNine].sort(sortTasks).map((task) => task.id)).toEqual([
      "nine",
      "ten",
    ]);

    const undated = makeTask({ id: "undated", title: "Beta" });
    expect([undated, atNine].sort(sortTasks).map((task) => task.id)).toEqual([
      "nine",
      "undated",
    ]);

    const done = makeTask({ id: "done", title: "Alpha", status: "done" });
    expect([done, undated].sort(sortTasks).map((task) => task.id)).toEqual([
      "undated",
      "done",
    ]);

    const alpha = makeTask({ id: "alpha", title: "Alpha" });
    const beta = makeTask({ id: "beta", title: "Beta" });
    expect([beta, alpha].sort(sortTasks).map((task) => task.id)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("groups dated tasks by day, sorted within each group", () => {
    const later = makeTask({
      id: "later",
      title: "Later",
      allDay: true,
      dueDate: "2026-07-16",
    });
    const earlierB = makeTask({
      id: "earlier-b",
      title: "Beta",
      allDay: true,
      dueDate: "2026-07-15",
    });
    const earlierA = makeTask({
      id: "earlier-a",
      title: "Alpha",
      allDay: true,
      dueDate: "2026-07-15",
    });
    const undated = makeTask({ id: "undated", title: "No date" });

    const groups = groupTasksByDay([later, undated, earlierB, earlierA]);

    expect(groups.map((group) => group.key)).toEqual([
      "2026-07-15",
      "2026-07-16",
    ]);
    expect(groups[0]?.tasks.map((task) => task.id)).toEqual([
      "earlier-a",
      "earlier-b",
    ]);
    expect(dateKey(groups[1]?.date ?? new Date(0))).toBe("2026-07-16");
  });
});

describe("display formatting", () => {
  it("formats dates and times consistently with Intl", () => {
    const date = new Date(2026, 6, 15, 9, 5);
    expect(formatLongDate(date)).toBe(
      new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(date),
    );
    expect(formatShortDate(date)).toBe(shortDate(date));
    expect(formatMonthYear(date)).toBe(
      new Intl.DateTimeFormat(undefined, {
        month: "long",
        year: "numeric",
      }).format(date),
    );
    expect(formatTime(date)).toBe(shortTime(date));
  });

  it("labels Today, Tomorrow, weekdays, and later dates", () => {
    const now = new Date(2026, 6, 15, 12, 0);
    expect(formatGroupDate("2026-07-15", now)).toBe("Today");
    expect(formatGroupDate("2026-07-16", now)).toBe("Tomorrow");
    expect(formatGroupDate("not-a-key", now)).toBe("not-a-key");

    const weekday = new Date(2026, 6, 18);
    expect(formatGroupDate(dateKey(weekday), now)).toBe(
      new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(weekday),
    );

    const later = new Date(2026, 6, 25);
    expect(formatGroupDate(dateKey(later), now)).toBe(
      new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(later),
    );
  });

  it("formats a task date for all-day and timed tasks", () => {
    const allDay = makeTask({ allDay: true, dueDate: "2026-07-15" });
    expect(formatTaskDate(allDay)).toBe(
      `All day · ${shortDate(new Date(2026, 6, 15))}`,
    );

    const timed = makeTask({ dueAt: "2026-07-15T13:30:00.000Z" });
    const instant = new Date(timed.dueAt ?? "");
    expect(formatTaskDate(timed)).toBe(
      `${shortDate(instant)} · ${shortTime(instant)}`,
    );
    expect(formatTaskDate(makeTask())).toBe("No date");
  });

  it("formats timestamps and relative ages", () => {
    const iso = "2026-07-15T13:30:00.000Z";
    const date = new Date(iso);
    expect(formatTimestamp(iso)).toBe(
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date),
    );
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp("not-a-date")).toBe("—");

    const now = 1_000_000_000_000;
    expect(formatRelativeTime(now - 5_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 30_000, now)).toBe("30s ago");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
    expect(formatRelativeTime(now + 10_000, now)).toBe("just now");
  });

  it("summarises recurrence rules", () => {
    expect(recurrenceLabel(null)).toBeNull();
    expect(recurrenceLabel("RRULE:FREQ=DAILY")).toBe("Every day");
    expect(recurrenceLabel("RRULE:FREQ=WEEKLY;INTERVAL=2")).toBe(
      "Every 2 weeks",
    );
    expect(recurrenceLabel("RRULE:FREQ=MONTHLY;INTERVAL=3")).toBe(
      "Every 3 months",
    );
    expect(recurrenceLabel("RRULE:FREQ=YEARLY")).toBe("Every year");
    expect(recurrenceLabel("RRULE:FREQ=HOURLY")).toBe("Repeats");
  });
});

describe("task presentation data", () => {
  it("prefers wall dates for all-day occurrence keys", () => {
    expect(
      taskOccurrenceKey(
        makeTask({
          allDay: true,
          dueDate: "2026-07-10",
          nextOccurrenceLocal: "2026-07-17T00:00:00",
        }),
      ),
    ).toBe("2026-07-17");
    expect(
      taskOccurrenceKey(makeTask({ allDay: true, dueDate: "2026-07-10" })),
    ).toBe("2026-07-10");
    expect(taskOccurrenceKey(makeTask({ allDay: true }))).toBeUndefined();

    expect(
      taskOccurrenceKey(
        makeTask({
          dueAt: "2026-07-10T13:30:00.000Z",
          nextOccurrenceAt: "2026-07-17T13:30:00.000Z",
        }),
      ),
    ).toBe("2026-07-17T13:30:00.000Z");
    expect(
      taskOccurrenceKey(
        makeTask({ dueDate: "2026-07-10", dueAt: null }),
      ),
    ).toBe("2026-07-10");
    expect(taskOccurrenceKey(makeTask())).toBeUndefined();
  });

  it("formats list names, user names, and colour slugs", () => {
    expect(listDisplayName(null)).toBe("List");
    expect(listDisplayName({ id: "l", name: "Work" })).toBe("Work");
    expect(listDisplayName({ id: "l", title: "Home" })).toBe("Home");
    expect(listDisplayName({ id: "l", name: "", title: "" })).toBe(
      "Untitled list",
    );

    expect(userDisplayName(null)).toBe("You");
    expect(userDisplayName({ id: "u", displayName: "ada" })).toBe("Ada");
    expect(userDisplayName({ id: "u", name: "grace" })).toBe("Grace");
    expect(userDisplayName({ id: "u", username: "linus" })).toBe("Linus");
    expect(userDisplayName({ id: "u", email: "sam@example.com" })).toBe("Sam");

    expect(listColorSlug(null)).toBe("persimmon");
    expect(listColorSlug("#B3401A")).toBe("persimmon");
    expect(listColorSlug("orange")).toBe("persimmon");
    expect(listColorSlug("green")).toBe("moss");
    expect(listColorSlug("purple")).toBe("plum");
    expect(listColorSlug("unknown")).toBe("persimmon");
  });

  it("finds the list attached to a task", () => {
    const lists = [
      { id: "work", name: "Work", color: "moss" },
      { id: "home", name: "Home", color: "rose" },
    ];
    expect(
      taskList(makeTask({ listId: "home" }), lists)?.name,
    ).toBe("Home");
    expect(taskList(makeTask({ listId: "missing" }), lists)).toBeNull();
    expect(taskList(makeTask({ listId: null }), lists)).toBeNull();
  });
});
