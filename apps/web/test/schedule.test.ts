import { describe, expect, it } from "vitest";
import type { ParsedCapture } from "@/api";
import {
  RECURRENCE_OPTIONS,
  addDaysToDateKey,
  captureScheduleFromParsed,
  inMinutes,
  localDateKey,
  localDateTimeToIso,
  recurrenceLabelForValue,
  recurrenceValue,
  rruleForValue,
  scheduleFields,
  scheduleForTask,
  snoozeLabel,
  toDateInput,
  toDateTimeLocal,
  todayDateInput,
  tomorrowAtNine,
  wallDateTimeFromLocal,
} from "../src/lib/schedule.js";
import { dateKey } from "../src/lib/format.js";
import { makeTask } from "./helpers.js";

const NY = "America/New_York";

describe("recurrence values and labels", () => {
  it("maps known RRULEs to their picker value, ignoring case and whitespace", () => {
    expect(recurrenceValue(null)).toBe("none");
    expect(recurrenceValue("rrule:freq=daily")).toBe("daily");
    expect(
      recurrenceValue(" RRULE:FREQ=WEEKLY ; BYDAY=MO,TU,WE,TH,FR "),
    ).toBe("weekdays");
    expect(recurrenceValue("RRULE:FREQ=WEEKLY;INTERVAL=2")).toBe("biweekly");
    expect(recurrenceValue("RRULE:FREQ=MONTHLY")).toBe("monthly");
    expect(recurrenceValue("RRULE:FREQ=YEARLY")).toBe("yearly");
  });

  it("falls back to a family match, then to custom", () => {
    expect(recurrenceValue("RRULE:FREQ=WEEKLY;COUNT=4")).toBe("weekly");
    expect(recurrenceValue("FREQ=HOURLY;INTERVAL=3")).toBe("custom");
    expect(recurrenceValue("not-an-rrule")).toBe("custom");
  });

  it("returns labels and RRULE payloads for picker values", () => {
    expect(recurrenceLabelForValue("weekdays")).toBe("Every weekday");
    expect(recurrenceLabelForValue("custom", "RRULE:FREQ=DAILY;COUNT=3")).toBe(
      "Custom repeat",
    );
    expect(recurrenceLabelForValue("custom")).toBe("Repeat");
    expect(recurrenceLabelForValue("unknown-value")).toBe("Doesn’t repeat");

    expect(rruleForValue("none")).toBeNull();
    expect(rruleForValue("daily")).toBe("RRULE:FREQ=DAILY");
    expect(rruleForValue("custom", "  RRULE:FREQ=DAILY;COUNT=3  ")).toBe(
      "RRULE:FREQ=DAILY;COUNT=3",
    );
    expect(rruleForValue("custom", "   ")).toBeNull();
  });

  it("keeps the public recurrence options unique by id and rrule", () => {
    expect(new Set(RECURRENCE_OPTIONS.map((option) => option.id)).size).toBe(
      RECURRENCE_OPTIONS.length,
    );
    expect(RECURRENCE_OPTIONS[0]).toEqual({
      id: "none",
      label: "Doesn’t repeat",
      rrule: null,
    });
  });
});

describe("schedule payloads", () => {
  it("builds a timed payload with a UTC instant and wall DTSTART", () => {
    const fields = scheduleFields({
      dateTimeLocal: "2026-07-15T09:30",
      rrule: "daily",
      timezone: NY,
    });

    expect(fields).toEqual({
      dueAt: "2026-07-15T13:30:00.000Z",
      dueDate: null,
      allDay: false,
      timezone: NY,
      rrule: "RRULE:FREQ=DAILY",
      dtstartLocal: "2026-07-15T09:30:00",
    });
  });

  it("builds an all-day payload keyed by the wall date", () => {
    const fields = scheduleFields({
      dateLocal: "2026-07-15",
      allDay: true,
      rrule: "weekly",
      timezone: NY,
    });

    expect(fields).toEqual({
      dueAt: null,
      dueDate: "2026-07-15",
      allDay: true,
      timezone: NY,
      rrule: "RRULE:FREQ=WEEKLY",
      dtstartLocal: "2026-07-15",
    });
  });

  it("infers all-day when only a date is supplied", () => {
    const fields = scheduleFields({
      dateLocal: "2026-07-16",
      timezone: NY,
    });
    expect(fields.allDay).toBe(true);
    expect(fields.dueDate).toBe("2026-07-16");
    expect(fields.dueAt).toBeNull();
    expect(fields.dtstartLocal).toBeNull();
  });

  it("clears the schedule and recurrence together", () => {
    const fields = scheduleFields({
      dateTimeLocal: "",
      dateLocal: "",
      rrule: "daily",
      timezone: NY,
    });
    expect(fields).toEqual({
      dueAt: null,
      dueDate: null,
      allDay: false,
      timezone: NY,
      rrule: null,
      dtstartLocal: null,
    });
  });

  it("uses a trimmed custom RRULE and never invents a DTSTART", () => {
    const fields = scheduleFields({
      dateTimeLocal: "2026-07-15T09:30",
      rrule: "custom",
      customRrule: "  RRULE:FREQ=DAILY;COUNT=3  ",
      timezone: NY,
    });
    expect(fields.rrule).toBe("RRULE:FREQ=DAILY;COUNT=3");
    expect(fields.dtstartLocal).toBe("2026-07-15T09:30:00");

    const noRepeat = scheduleFields({
      dateLocal: "2026-07-15",
      allDay: true,
      rrule: "custom",
      customRrule: "   ",
      timezone: NY,
    });
    expect(noRepeat.rrule).toBeNull();
    expect(noRepeat.dtstartLocal).toBeNull();
  });
});

describe("local date and datetime helpers", () => {
  it("formats a datetime-local value from an ISO instant", () => {
    expect(toDateTimeLocal("2026-07-15T13:30:00.000Z")).toBe(
      "2026-07-15T09:30",
    );
    expect(toDateTimeLocal(null)).toBe("");
    expect(toDateTimeLocal("not-a-date")).toBe("");
  });

  it("normalises wall datetimes and ISO input", () => {
    expect(wallDateTimeFromLocal("2026-07-15T09:30")).toBe(
      "2026-07-15T09:30:00",
    );
    expect(wallDateTimeFromLocal("2026-07-15T09:30:45")).toBe(
      "2026-07-15T09:30:45",
    );
    expect(wallDateTimeFromLocal("2026-07-15")).toBe(
      "2026-07-15T00:00:00",
    );
    expect(wallDateTimeFromLocal("")).toBeNull();

    expect(localDateTimeToIso("2026-07-15T09:30")).toBe(
      "2026-07-15T13:30:00.000Z",
    );
    expect(localDateTimeToIso("not-a-date")).toBeNull();
    expect(localDateTimeToIso("")).toBeNull();
  });

  it("keeps all-day dates as plain keys", () => {
    expect(toDateInput("2026-07-15T00:00:00")).toBe("2026-07-15");
    expect(toDateInput(null)).toBe("");
    expect(localDateKey("2026-07-15T23:59:59")).toBe("2026-07-15");
    expect(todayDateInput(new Date(2026, 6, 15, 23, 59))).toBe("2026-07-15");
  });

  it("adds days across month and leap-year boundaries", () => {
    expect(addDaysToDateKey("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDaysToDateKey("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysToDateKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDaysToDateKey("not-a-date", 1)).toBe("not-a-date");
  });

  it("computes relative snooze and tomorrow targets in local time", () => {
    const now = new Date(2026, 6, 15, 15, 0, 0, 0);
    expect(inMinutes(10, now.getTime()).toISOString()).toBe(
      "2026-07-15T19:10:00.000Z",
    );

    const tomorrow = tomorrowAtNine(now);
    expect(dateKey(tomorrow)).toBe("2026-07-16");
    expect(tomorrow.getHours()).toBe(9);
    expect(tomorrow.getMinutes()).toBe(0);
  });

  it("labels a snooze target with a weekday and time", () => {
    const until = new Date("2026-07-15T13:30:00.000Z");
    const expected = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(until);
    expect(snoozeLabel(until)).toBe(expected);
  });
});

describe("capture and task schedule hydration", () => {
  it("returns empty capture fields for a missing parse", () => {
    expect(captureScheduleFromParsed(null)).toEqual({
      dateTimeLocal: "",
      dateLocal: "",
      allDay: false,
      recurrence: "none",
      customRrule: "",
    });
  });

  it("hydrates a timed capture from dueAt or dtstartLocal", () => {
    const fromDueAt = captureScheduleFromParsed({
      title: "Call Sam",
      dueAt: "2026-07-15T13:30:00.000Z",
      allDay: false,
    } satisfies ParsedCapture);
    expect(fromDueAt.dateTimeLocal).toBe("2026-07-15T09:30");
    expect(fromDueAt.dateLocal).toBe("");

    const fromWall = captureScheduleFromParsed({
      title: "Call Sam",
      dtstartLocal: "2026-07-15T09:30:00",
      rrule: "RRULE:FREQ=DAILY",
    } satisfies ParsedCapture);
    expect(fromWall.dateTimeLocal).toBe("2026-07-15T09:30");
    expect(fromWall.recurrence).toBe("daily");
  });

  it("hydrates an all-day capture and preserves a custom RRULE", () => {
    const parsed = captureScheduleFromParsed({
      title: "Water plants",
      dueDate: "2026-07-16",
      allDay: true,
      rrule: "RRULE:FREQ=HOURLY;INTERVAL=6",
    } satisfies ParsedCapture);

    expect(parsed).toEqual({
      dateTimeLocal: "",
      dateLocal: "2026-07-16",
      allDay: true,
      recurrence: "custom",
      customRrule: "RRULE:FREQ=HOURLY;INTERVAL=6",
    });
  });

  it("hydrates a task from its next occurrence without changing wall time", () => {
    const allDay = scheduleForTask(
      makeTask({
        id: "all-day",
        allDay: true,
        dueDate: "2026-07-10",
        nextOccurrenceLocal: "2026-07-17T00:00:00",
        rrule: "RRULE:FREQ=DAILY",
      }),
    );
    expect(allDay.dateLocal).toBe("2026-07-17");
    expect(allDay.allDay).toBe(true);
    expect(allDay.recurrence).toBe("daily");

    const timed = scheduleForTask(
      makeTask({
        id: "timed",
        allDay: false,
        dueAt: "2026-07-10T13:30:00.000Z",
        nextOccurrenceAt: "2026-07-17T13:30:00.000Z",
      }),
    );
    expect(timed.dateTimeLocal).toBe("2026-07-17T09:30");
    expect(timed.dateLocal).toBe("");
    expect(timed.allDay).toBe(false);
  });
});

describe("DST edges", () => {
  it("resolves the spring-forward gap to the post-transition instant", () => {
    // 02:30 does not exist on 2026-03-08 in New York; the runtime reads it as
    // 03:30 EDT, the same instant as 07:30Z.
    const iso = localDateTimeToIso("2026-03-08T02:30");
    expect(iso).toBe("2026-03-08T07:30:00.000Z");
    expect(new Date(iso ?? "").getHours()).toBe(3);
  });

  it("keeps the fold ambiguous time on the first (EDT) occurrence", () => {
    // 01:30 happens twice on 2026-11-01; Date chooses the earlier EDT one.
    const iso = localDateTimeToIso("2026-11-01T01:30");
    expect(iso).toBe("2026-11-01T05:30:00.000Z");
    expect(new Date(iso ?? "").getTime()).toBe(
      new Date("2026-11-01T05:30:00.000Z").getTime(),
    );
  });

  it("keeps an all-day recurrence anchored to the wall date across a DST change", () => {
    const fields = scheduleFields({
      dateLocal: "2026-03-08",
      allDay: true,
      rrule: "daily",
      timezone: NY,
    });
    expect(fields.dueDate).toBe("2026-03-08");
    expect(fields.dtstartLocal).toBe("2026-03-08");
    expect(fields.dueAt).toBeNull();
  });
});
