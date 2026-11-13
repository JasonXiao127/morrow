/**
 * Pure Round 4 CalDAV VTODO tests: golden serializer fixtures, parser
 * behaviour, and opaque ETag parsing. Route-level tests live in caldav.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CalDavIcsError,
  MORROW_TO_ICAL_PRIORITY,
  caldavHrefFor,
  calendarObjectForTask,
  entityTagMatches,
  icalUidFor,
  parseCalDavIcs,
  parseEntityTagHeader,
  priorityFromIcal,
  taskToVtodo,
  type CalDavTask,
} from "../src/caldavVtodo.js";

const BASE: CalDavTask = {
  id: "01900000-0000-7000-8000-000000000101",
  ical_uid: "fixture-minimal@example.test",
  caldav_href: "fixture-minimal.ics",
  title: "Minimal task",
  notes: null,
  status: "open",
  priority: 0,
  due_at: null,
  due_date: null,
  all_day: 0,
  timezone: "UTC",
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
  created_at: "2026-11-02T12:00:00.000Z",
  updated_at: "2026-11-02T12:00:00.000Z",
};

const fixtures: Array<{
  name: string;
  task: CalDavTask;
  tags?: Array<{ name: string }>;
}> = [
  { name: "minimal", task: BASE },
  {
    name: "all-day",
    task: {
      ...BASE,
      id: "01900000-0000-7000-8000-000000000102",
      ical_uid: "fixture-all-day@example.test",
      caldav_href: "fixture-all-day.ics",
      title: "Water the plants",
      due_date: "2026-11-10",
      all_day: 1,
      priority: 2,
    },
    tags: [{ name: "Work" }, { name: "Home" }],
  },
  {
    name: "timed",
    task: {
      ...BASE,
      id: "01900000-0000-7000-8000-000000000103",
      ical_uid: "fixture-timed@example.test",
      caldav_href: "fixture-timed.ics",
      title: "Call the dentist",
      due_at: "2026-11-10T09:30:00.000Z",
      rev: 2,
    },
  },
  {
    name: "completed",
    task: {
      ...BASE,
      id: "01900000-0000-7000-8000-000000000104",
      ical_uid: "fixture-completed@example.test",
      caldav_href: "fixture-completed.ics",
      title: "File taxes",
      status: "done",
      completed_at: "2026-11-09T18:45:00.000Z",
      due_date: "2026-11-09",
      all_day: 1,
      priority: 4,
      rev: 3,
      updated_at: "2026-11-09T18:45:00.000Z",
    },
  },
  {
    name: "cancelled",
    task: {
      ...BASE,
      id: "01900000-0000-7000-8000-000000000105",
      ical_uid: "fixture-cancelled@example.test",
      caldav_href: "fixture-cancelled.ics",
      title: "Cancelled appointment",
      due_at: "2026-11-12T15:00:00.000Z",
      status: "cancelled",
    },
  },
  {
    name: "priority",
    task: {
      ...BASE,
      id: "01900000-0000-7000-8000-000000000106",
      ical_uid: "fixture-priority@example.test",
      caldav_href: "fixture-priority.ics",
      title: "Low priority chore",
      priority: 1,
    },
  },
  {
    name: "tag",
    task: {
      ...BASE,
      id: "01900000-0000-7000-8000-000000000107",
      ical_uid: "fixture-tag@example.test",
      caldav_href: "fixture-tag.ics",
      title: "Tagged task",
      notes: "Line one\nLine two, with comma; and semicolon \\ slash",
      priority: 3,
    },
    tags: [{ name: "Errands, weekend" }, { name: "Café ☕" }],
  },
  {
    name: "alarm",
    task: {
      ...BASE,
      id: "01900000-0000-7000-8000-000000000108",
      ical_uid: "fixture-alarm@example.test",
      caldav_href: "fixture-alarm.ics",
      title: "Alarm task",
      due_at: "2026-11-10T09:30:00.000Z",
      remind_offset_minutes: -30,
      rev: 2,
    },
  },
];

function fixture(name: string): string {
  return readFileSync(
    join(import.meta.dirname, "fixtures", "caldav", `${name}.ics`),
    "utf8",
  )
    .replaceAll("\r\n", "\n")
    .trimEnd();
}

describe("VTODO serializer golden fixtures", () => {
  for (const { name, task, tags = [] } of fixtures) {
    it(`matches ${name}.ics`, () => {
      expect(taskToVtodo(task, tags).replaceAll("\r\n", "\n").trimEnd()).toBe(
        fixture(name),
      );
    });
  }

  it("never emits DTEND or METHOD in a calendar object resource", () => {
    const body = calendarObjectForTask(fixtures[1]!.task, fixtures[1]!.tags);
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("BEGIN:VTODO");
    expect(body).not.toContain("DTEND");
    expect(body).not.toContain("METHOD:");
    expect(body).not.toContain("TZID");
  });

  it("emits an absolute VALARM when only remind_at is known", () => {
    const body = taskToVtodo({
      ...BASE,
      remind_at: "2026-11-10T08:55:00.000Z",
    });
    expect(body).toContain("TRIGGER;VALUE=DATE-TIME:20261110T085500Z");
  });

  it("keeps SEQUENCE monotonic with task rev", () => {
    expect(taskToVtodo({ ...BASE, rev: 1 })).toContain("SEQUENCE:1");
    expect(taskToVtodo({ ...BASE, rev: 7 })).toContain("SEQUENCE:7");
  });

  it("maps priorities on a documented 0-9 scale", () => {
    expect(MORROW_TO_ICAL_PRIORITY).toEqual({ 0: 0, 1: 9, 2: 5, 3: 3, 4: 1 });
    expect(priorityToFixtures()).toEqual([0, 9, 5, 3, 1]);
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(priorityFromIcal)).toEqual([
      0, 4, 4, 3, 3, 2, 1, 1,
    ]);
  });

  it("falls back to id-based UID and href for REST-created rows", () => {
    expect(icalUidFor({ ...BASE, ical_uid: null })).toBe(`${BASE.id}@morrow`);
    expect(caldavHrefFor({ ...BASE, caldav_href: null })).toBe(`${BASE.id}.ics`);
  });
});

function priorityToFixtures(): number[] {
  return [0, 1, 2, 3, 4].map((priority) =>
    Number(
      /PRIORITY:(\d+)/.exec(taskToVtodo({ ...BASE, priority }))?.[1] ?? -1,
    ),
  );
}

describe("VTODO parser", () => {
  it("parses a basic VTODO", () => {
    const parsed = parseCalDavIcs([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VTODO",
      "UID:client-uid-1",
      "SUMMARY:Buy milk",
      "DESCRIPTION:Two litres",
      "DUE:20261110T090000Z",
      "STATUS:NEEDS-ACTION",
      "PRIORITY:3",
      "CATEGORIES:Home,Errands",
      "SEQUENCE:4",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT15M",
      "END:VALARM",
      "END:VTODO",
      "END:VCALENDAR",
    ].join("\r\n"));

    expect(parsed.uid).toBe("client-uid-1");
    expect(parsed.summary).toBe("Buy milk");
    expect(parsed.description).toBe("Two litres");
    expect(parsed.due?.instant).toBe("2026-11-10T09:00:00.000Z");
    expect(parsed.priority).toBe(3);
    expect(parsed.categories).toEqual(["Home", "Errands"]);
    expect(parsed.sequence).toBe(4);
    expect(parsed.alarms).toEqual([
      { action: "DISPLAY", triggerMinutes: -15, triggerAt: null },
    ]);
  });

  it("recognizes METHOD and rounds fractional alarm triggers to minutes", () => {
    const parsed = parseCalDavIcs(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "METHOD:REQUEST",
        "BEGIN:VTODO",
        "UID:method-uid",
        "SUMMARY:Method",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-PT90S",
        "END:VALARM",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(parsed.method).toBe("REQUEST");
    expect(parsed.alarms[0]?.triggerMinutes).toBe(-2);
  });

  it("rejects VEVENT with a CalDAV component precondition", () => {
    try {
      parseCalDavIcs(
        [
          "BEGIN:VCALENDAR",
          "BEGIN:VEVENT",
          "UID:event-1",
          "DTSTART:20261110T090000Z",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
      );
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(CalDavIcsError);
      const caldav = err as CalDavIcsError;
      expect(caldav.code).toBe("vevent_not_supported");
      expect(caldav.status).toBe(403);
      expect(caldav.precondition).toBe("supported-calendar-component");
    }
  });

  it("rejects DUE and DURATION together", () => {
    expect(() =>
      parseCalDavIcs(
        [
          "BEGIN:VCALENDAR",
          "BEGIN:VTODO",
          "UID:duration-1",
          "DUE:20261110T090000Z",
          "DURATION:PT1H",
          "END:VTODO",
          "END:VCALENDAR",
        ].join("\r\n"),
      ),
    ).toThrow(/DUE and DURATION/);
  });

  it("rejects an unknown TZID instead of shifting the time", () => {
    try {
      parseCalDavIcs(
        [
          "BEGIN:VCALENDAR",
          "BEGIN:VTODO",
          "UID:tzid-1",
          "DUE;TZID=Mars/Olympus:20261110T090000",
          "END:VTODO",
          "END:VCALENDAR",
        ].join("\r\n"),
      );
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(CalDavIcsError);
      expect((err as CalDavIcsError).code).toBe("unsupported_tzid");
      expect((err as CalDavIcsError).status).toBe(400);
    }
  });

  it("resolves an IANA TZID wall time to its UTC instant", () => {
    const parsed = parseCalDavIcs(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VTIMEZONE",
        "TZID:America/New_York",
        "BEGIN:STANDARD",
        "DTSTART:19701101T020000",
        "TZOFFSETFROM:-0400",
        "TZOFFSETTO:-0500",
        "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VTODO",
        "UID:tzid-ny",
        "DUE;TZID=America/New_York:20261110T090000",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    // November 10 is EST (UTC-5), so 09:00 wall time is 14:00Z.
    expect(parsed.due?.instant).toBe("2026-11-10T14:00:00.000Z");
    expect(parsed.due?.tzid).toBe("America/New_York");
    expect(parsed.due?.floating).toBe(false);
  });

  it("accepts UTC TZID and floating values with documented UTC behaviour", () => {
    const utc = parseCalDavIcs(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VTODO",
        "UID:tzid-utc",
        "DUE;TZID=UTC:20261110T090000",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(utc.due?.instant).toBe("2026-11-10T09:00:00.000Z");

    const floating = parseCalDavIcs(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VTODO",
        "UID:floating",
        "DUE:20261110T090000",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(floating.due?.floating).toBe(true);
    expect(floating.due?.instant).toBe("2026-11-10T09:00:00.000Z");
  });

  it("parses RECURRENCE-ID and EXDATE", () => {
    const parsed = parseCalDavIcs(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VTODO",
        "UID:exception-uid",
        "RECURRENCE-ID:20260115T090000Z",
        "EXDATE:20260116T090000Z,20260117T090000Z",
        "SUMMARY:One occurrence changed",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(parsed.recurrenceId?.instant).toBe("2026-01-15T09:00:00.000Z");
    expect(parsed.exdates.map((value) => value.instant)).toEqual([
      "2026-01-16T09:00:00.000Z",
      "2026-01-17T09:00:00.000Z",
    ]);
  });

  it("serializes a recurrence exception with the same UID and RECURRENCE-ID", () => {
    const task: CalDavTask = {
      ...BASE,
      timezone: "UTC",
      recurrence_id: "2026-01-15T09:00:00.000Z",
      due_at: "2026-01-15T11:00:00.000Z",
      title: "Changed occurrence",
    };
    const body = taskToVtodo(task);
    expect(body).toContain(`UID:${BASE.ical_uid}`);
    expect(body).toContain("RECURRENCE-ID:20260115T090000Z");
    expect(body).toContain("SUMMARY:Changed occurrence");
    expect(body).not.toContain("RRULE:");
  });

  it("does not let a VTIMEZONE DTSTART overwrite the task DTSTART", () => {
    const parsed = parseCalDavIcs(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VTIMEZONE",
        "TZID:Europe/Berlin",
        "BEGIN:STANDARD",
        "DTSTART:19701025T030000",
        "TZOFFSETFROM:+0200",
        "TZOFFSETTO:+0100",
        "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VTODO",
        "UID:vtimezone-1",
        "DTSTART:20261110T080000Z",
        "DUE:20261110T090000Z",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(parsed.dtstart?.instant).toBe("2026-11-10T08:00:00.000Z");
    expect(parsed.due?.instant).toBe("2026-11-10T09:00:00.000Z");
  });

  it("handles folded lines, unicode, escaped text and categories", () => {
    const parsed = parseCalDavIcs(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VTODO",
        "UID:folded-1",
        "SUMMARY:Café ☕ and a long sum",
        " mary that was folded",
        "DESCRIPTION:Line one\\nLine two\\, comma\\; semicolon",
        "CATEGORIES:Café ☕,Errands\\, weekend",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(parsed.summary).toBe("Café ☕ and a long summary that was folded");
    expect(parsed.description).toBe("Line one\nLine two, comma; semicolon");
    expect(parsed.categories).toEqual(["Café ☕", "Errands, weekend"]);
  });

  it("parses absolute VALARM triggers", () => {
    const parsed = parseCalDavIcs(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VTODO",
        "UID:absolute-alarm",
        "DUE:20261110T090000Z",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER;VALUE=DATE-TIME:20261110T085500Z",
        "END:VALARM",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(parsed.alarms[0]?.triggerAt).toBe("2026-11-10T08:55:00.000Z");
    expect(parsed.alarms[0]?.triggerMinutes).toBeNull();
  });

  it("leaves a missing UID for the route to reject on create", () => {
    const parsed = parseCalDavIcs(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VTODO",
        "SUMMARY:No UID",
        "END:VTODO",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    expect(parsed.uid).toBeNull();
  });
});

describe("opaque CalDAV ETag headers", () => {
  it("parses strong, weak, wildcard and lists without the REST rev shape", () => {
    expect(parseEntityTagHeader('"abc123"')).toEqual({
      wildcard: false,
      tags: [{ value: '"abc123"', weak: false }],
    });
    expect(parseEntityTagHeader('W/"weak", "strong"')).toEqual({
      wildcard: false,
      tags: [
        { value: '"weak"', weak: true },
        { value: '"strong"', weak: false },
      ],
    });
    expect(parseEntityTagHeader("*")).toEqual({ wildcard: true, tags: [] });
    expect(parseEntityTagHeader("not-an-etag")).toBeNull();
  });

  it("matches strong tags for If-Match and allows weak only where requested", () => {
    const weak = parseEntityTagHeader('W/"abc"')!;
    expect(entityTagMatches(weak, '"abc"')).toBe(false);
    expect(entityTagMatches(weak, '"abc"', true)).toBe(true);
    expect(entityTagMatches(parseEntityTagHeader("*")!, '"anything"')).toBe(true);
  });
});
