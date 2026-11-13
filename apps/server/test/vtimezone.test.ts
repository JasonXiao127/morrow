/**
 * VTIMEZONE output and TZID preservation (Phase 3). These are pure serializer
 * tests; route-level round-trips live in caldav.test.ts.
 */
import { describe, expect, it } from "vitest";
import { generateOccurrences, resolveWallTime } from "@morrow/shared";
import {
  calendarObjectForTask,
  parseCalDavIcs,
  taskToVtodo,
  vtimezoneForTask,
  type CalDavTask,
} from "../src/caldavVtodo.js";
import { buildVtimezone } from "../src/vtimezone.js";

const BASE: CalDavTask = {
  id: "01900000-0000-7000-8000-000000000201",
  ical_uid: "tz-fixture@example.test",
  caldav_href: "tz-fixture.ics",
  title: "Timezone fixture",
  notes: null,
  status: "open",
  priority: 0,
  due_at: null,
  due_date: null,
  all_day: 0,
  timezone: "Europe/Berlin",
  remind_at: null,
  reminder_time_local: null,
  remind_offset_minutes: null,
  dtstart_local: null,
  next_occurrence_at: null,
  next_occurrence_local: null,
  rrule: null,
  recurrence_until_date: null,
  recurrence_count: null,
  completed_at: null,
  rev: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("VTIMEZONE generation", () => {
  it("emits the correct Berlin offsets and DST onsets", () => {
    const block = buildVtimezone("Europe/Berlin", {
      fromYear: 2026,
      toYear: 2026,
    });
    expect(block).toBeTruthy();
    expect(block).toContain("BEGIN:VTIMEZONE");
    expect(block).toContain("TZID:Europe/Berlin");
    expect(block).toContain("TZOFFSETFROM:+0100");
    expect(block).toContain("TZOFFSETTO:+0200");
    expect(block).toContain("TZOFFSETFROM:+0200");
    expect(block).toContain("TZOFFSETTO:+0100");
    // 2026: spring forward 29 March 02:00 CET, fall back 25 October 03:00 CEST.
    expect(block).toContain("DTSTART:20260329T020000");
    expect(block).toContain("DTSTART:20261025T030000");
    expect(block).toContain("BEGIN:DAYLIGHT");
    expect(block).toContain("BEGIN:STANDARD");
  });

  it("returns null for UTC aliases and fixed zones still get a block", () => {
    expect(buildVtimezone("UTC", { fromYear: 2026, toYear: 2026 })).toBeNull();
    expect(buildVtimezone("Etc/UTC", { fromYear: 2026, toYear: 2026 })).toBeNull();
    const fixed = buildVtimezone("Etc/GMT+5", {
      fromYear: 2026,
      toYear: 2026,
    });
    expect(fixed).toContain("TZOFFSETTO:-0500");
    expect(fixed).not.toContain("BEGIN:DAYLIGHT");
  });

  it("covers the task window with a bounded number of years", () => {
    const block = buildVtimezone("America/New_York", {
      fromYear: 2020,
      toYear: 2090,
      maxYears: 4,
    });
    expect(block).toBeTruthy();
    const daylight = (block?.match(/BEGIN:DAYLIGHT/g) ?? []).length;
    expect(daylight).toBeGreaterThan(0);
    // A four-year window plus the guard years at each edge.
    expect(daylight).toBeLessThanOrEqual(6);
  });
});

describe("TZID serialization", () => {
  it("keeps UTC tasks byte-compatible (no TZID, no VTIMEZONE)", () => {
    const task: CalDavTask = {
      ...BASE,
      timezone: "UTC",
      due_at: "2026-11-10T09:30:00.000Z",
    };
    expect(taskToVtodo(task)).toContain("DUE:20261110T093000Z");
    expect(taskToVtodo(task)).not.toContain("TZID=");
    expect(calendarObjectForTask(task)).not.toContain("BEGIN:VTIMEZONE");
  });

  it("emits DUE/DTSTART with TZID and a matching VTIMEZONE", () => {
    const task: CalDavTask = {
      ...BASE,
      due_at: "2026-01-15T09:30:00.000Z",
      dtstart_local: "2026-01-15T09:00:00",
      rrule: "RRULE:FREQ=DAILY;COUNT=2",
    };
    const object = calendarObjectForTask(task);
    expect(object).toContain("BEGIN:VTIMEZONE");
    expect(object).toContain("TZID:Europe/Berlin");
    expect(object).toContain("DTSTART;TZID=Europe/Berlin:20260115T090000");
    expect(object).toContain("DUE;TZID=Europe/Berlin:20260115T103000");
    // VTIMEZONE must appear before the VTODO component.
    expect(object.indexOf("END:VTIMEZONE")).toBeLessThan(
      object.indexOf("BEGIN:VTODO"),
    );
    expect(vtimezoneForTask(task)).toContain("TZID:Europe/Berlin");
  });

  it("round-trips a timed TZID value and a DST-gap wall time", () => {
    const winter: CalDavTask = {
      ...BASE,
      due_at: "2026-01-15T09:30:00.000Z",
    };
    const parsedWinter = parseCalDavIcs(calendarObjectForTask(winter));
    expect(parsedWinter.due?.instant).toBe("2026-01-15T09:30:00.000Z");
    expect(parsedWinter.due?.tzid).toBe("Europe/Berlin");

    // The instant after the spring transition is 03:30 CEST; serializing the
    // wall value must not invent a nonexistent 02:30.
    const gap: CalDavTask = {
      ...BASE,
      due_at: "2026-03-29T01:30:00.000Z",
    };
    const gapObject = calendarObjectForTask(gap);
    expect(gapObject).toContain("DUE;TZID=Europe/Berlin:20260329T033000");
    expect(parseCalDavIcs(gapObject).due?.instant).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });

  it("documents the fold: the wall value is ambiguous and reads as the earlier instant", () => {
    const beforeFold: CalDavTask = {
      ...BASE,
      due_at: "2026-10-25T00:30:00.000Z", // 02:30 CEST
    };
    const afterFold: CalDavTask = {
      ...BASE,
      due_at: "2026-10-25T01:30:00.000Z", // 02:30 CET
    };
    expect(taskToVtodo(beforeFold)).toContain(
      "DUE;TZID=Europe/Berlin:20261025T023000",
    );
    expect(taskToVtodo(afterFold)).toContain(
      "DUE;TZID=Europe/Berlin:20261025T023000",
    );
    // RFC 5545 cannot distinguish the two walls without an offset; the
    // compatible policy chooses the first occurrence (CEST).
    expect(
      parseCalDavIcs(calendarObjectForTask(afterFold)).due?.instant,
    ).toBe("2026-10-25T00:30:00.000Z");
    expect(parseCalDavIcs(calendarObjectForTask(beforeFold)).due?.instant).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  it("keeps a recurring wall-time series at 09:00 across the DST change", () => {
    const task: CalDavTask = {
      ...BASE,
      dtstart_local: "2026-03-27T09:00:00",
      rrule: "RRULE:FREQ=DAILY;COUNT=4",
    };
    const object = calendarObjectForTask(task);
    expect(object).toContain("DTSTART;TZID=Europe/Berlin:20260327T090000");
    expect(object).toContain("RRULE:FREQ=DAILY;COUNT=4");

    const occurrences = generateOccurrences({
      rrule: "FREQ=DAILY",
      dtstartLocal: "2026-03-27T09:00:00",
      timezone: "Europe/Berlin",
      count: 4,
    });
    expect(occurrences.map((occurrence) => occurrence.local)).toEqual([
      "2026-03-27T09:00:00",
      "2026-03-28T09:00:00",
      "2026-03-29T09:00:00",
      "2026-03-30T09:00:00",
    ]);
    // 27/28 March are CET (08:00Z); after the transition the wall is CEST.
    expect(occurrences[0]?.instantIso).toBe("2026-03-27T08:00:00.000Z");
    expect(occurrences[2]?.instantIso).toBe("2026-03-29T07:00:00.000Z");
    expect(occurrences[3]?.instantIso).toBe("2026-03-30T07:00:00.000Z");
    expect(resolveWallTime("2026-03-30T09:00:00", "Europe/Berlin").instantIso).toBe(
      "2026-03-30T07:00:00.000Z",
    );
  });
});
