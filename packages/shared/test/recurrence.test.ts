import { describe, expect, it } from "vitest";
import {
  assertValidRecurrence,
  completionAnchor,
  generateOccurrences,
  listOccurrences,
  nextCompletionOccurrence,
  nextOccurrenceAfter,
  nextOccurrenceForMode,
  nextScheduledOccurrence,
  resolveWallTime,
  toUtcIso,
  type RecurrenceInput,
} from "../src/index.js";

const NY = "America/New_York";

function monthly31(
  clampPolicy: "skip" | "last-day" = "skip",
  extra: Partial<RecurrenceInput> = {},
): RecurrenceInput {
  return {
    rrule: "FREQ=MONTHLY;BYMONTHDAY=31",
    dtstartLocal: "2026-01-31T09:00:00",
    timezone: NY,
    clampPolicy,
    ...extra,
  };
}

describe("monthly invalid dates", () => {
  it("skips months without day 31 by default", () => {
    const occurrences = listOccurrences(monthly31("skip"), 4);
    expect(occurrences.map((o) => o.local)).toEqual([
      "2026-01-31T09:00:00",
      "2026-03-31T09:00:00",
      "2026-05-31T09:00:00",
      "2026-07-31T09:00:00",
    ]);
  });

  it("clamps missing months to the last day when requested", () => {
    const occurrences = listOccurrences(monthly31("last-day"), 5);
    expect(occurrences.map((o) => o.local)).toEqual([
      "2026-01-31T09:00:00",
      "2026-02-28T09:00:00",
      "2026-03-31T09:00:00",
      "2026-04-30T09:00:00",
      "2026-05-31T09:00:00",
    ]);
    expect(occurrences.map((o) => o.instantIso)).toEqual([
      "2026-01-31T14:00:00.000Z",
      "2026-02-28T14:00:00.000Z",
      "2026-03-31T13:00:00.000Z",
      "2026-04-30T13:00:00.000Z",
      "2026-05-31T13:00:00.000Z",
    ]);
  });

  it("clamps only the missing month for day 30 (not a blanket -1)", () => {
    const occurrences = listOccurrences(
      {
        rrule: "FREQ=MONTHLY;BYMONTHDAY=30",
        dtstartLocal: "2026-01-30T09:00:00",
        timezone: NY,
        clampPolicy: "last-day",
      },
      4,
    );
    expect(occurrences.map((o) => o.local)).toEqual([
      "2026-01-30T09:00:00",
      "2026-02-28T09:00:00",
      "2026-03-30T09:00:00",
      "2026-04-30T09:00:00",
    ]);
  });

  it("handles every 6 months from Aug 31 with skip and last-day", () => {
    const base: RecurrenceInput = {
      rrule: "FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=31",
      dtstartLocal: "2026-08-31T09:00:00",
      timezone: NY,
    };
    expect(listOccurrences({ ...base, clampPolicy: "skip" }, 3).map((o) => o.local)).toEqual([
      "2026-08-31T09:00:00",
      "2027-08-31T09:00:00",
      "2028-08-31T09:00:00",
    ]);
    expect(
      listOccurrences({ ...base, clampPolicy: "last-day" }, 4).map((o) => o.local),
    ).toEqual([
      "2026-08-31T09:00:00",
      "2027-02-28T09:00:00",
      "2027-08-31T09:00:00",
      "2028-02-29T09:00:00",
    ]);
  });

  it("clamps a yearly Feb 29 series", () => {
    const occurrences = listOccurrences(
      {
        rrule: "FREQ=YEARLY",
        dtstartLocal: "2024-02-29T09:00:00",
        timezone: NY,
        clampPolicy: "last-day",
        count: 3,
      },
      3,
    );
    expect(occurrences.map((o) => o.local)).toEqual([
      "2024-02-29T09:00:00",
      "2025-02-28T09:00:00",
      "2026-02-28T09:00:00",
    ]);
  });
});

describe("COUNT / UNTIL", () => {
  it("COUNT includes DTSTART and counts valid occurrences", () => {
    const occurrences = listOccurrences(
      monthly31("last-day", {
        rrule: "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3",
      }),
      10,
    );
    expect(occurrences.map((o) => o.local)).toEqual([
      "2026-01-31T09:00:00",
      "2026-02-28T09:00:00",
      "2026-03-31T09:00:00",
    ]);
  });

  it("COUNT includes DTSTART even when it does not match BYDAY", () => {
    const occurrences = listOccurrences(
      {
        // 2026-01-01 is a Thursday; the rule selects Mondays.
        rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3",
        dtstartLocal: "2026-01-01T09:00:00",
        timezone: NY,
      },
      10,
    );
    expect(occurrences.map((o) => o.local)).toEqual([
      "2026-01-01T09:00:00",
      "2026-01-05T09:00:00",
      "2026-01-12T09:00:00",
    ]);
  });

  it("UNTIL is inclusive and uses a UTC instant", () => {
    const occurrences = listOccurrences(
      {
        rrule: "FREQ=MONTHLY;BYMONTHDAY=31;UNTIL=20260331T235959Z",
        dtstartLocal: "2026-01-31T09:00:00",
        timezone: NY,
      },
      10,
    );
    expect(occurrences.map((o) => o.local)).toEqual([
      "2026-01-31T09:00:00",
      "2026-03-31T09:00:00",
    ]);
  });

  it("UNTIL date is inclusive of the whole local day", () => {
    const occurrences = listOccurrences(
      monthly31("last-day", { untilDate: "2026-03-31" }),
      10,
    );
    expect(occurrences.map((o) => o.local)).toEqual([
      "2026-01-31T09:00:00",
      "2026-02-28T09:00:00",
      "2026-03-31T09:00:00",
    ]);
  });

  it("COUNT and UNTIL are mutually exclusive", () => {
    expect(() =>
      listOccurrences(
        {
          rrule: "FREQ=DAILY;COUNT=3;UNTIL=20260110T000000Z",
          dtstartLocal: "2026-01-01T09:00:00",
          timezone: NY,
        },
        10,
      ),
    ).toThrow(/mutually exclusive/);

    expect(() =>
      listOccurrences(
        monthly31("skip", {
          count: 3,
          untilUtc: "2026-03-01T00:00:00.000Z",
        }),
        10,
      ),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects UNTIL before DTSTART and bad counts", () => {
    expect(() =>
      listOccurrences(
        {
          rrule: "FREQ=DAILY;UNTIL=20260101T000000Z",
          dtstartLocal: "2026-01-01T09:00:00",
          timezone: NY,
        },
        1,
      ),
    ).toThrow(/before DTSTART/);
    expect(() =>
      listOccurrences(
        {
          rrule: "FREQ=DAILY;COUNT=0",
          dtstartLocal: "2026-01-01T09:00:00",
          timezone: NY,
        },
        1,
      ),
    ).toThrow(/COUNT/);
  });
});

describe("DST recurrence", () => {
  it("resolves a spring-forward gap while keeping the floating local", () => {
    const occurrences = listOccurrences(
      {
        rrule: "FREQ=DAILY;COUNT=3",
        dtstartLocal: "2026-03-07T02:30:00",
        timezone: NY,
      },
      3,
    );
    expect(occurrences[0]?.local).toBe("2026-03-07T02:30:00");
    expect(occurrences[0]?.instantIso).toBe("2026-03-07T07:30:00.000Z");
    expect(occurrences[1]?.local).toBe("2026-03-08T02:30:00");
    expect(occurrences[1]?.wall).toBe("2026-03-08T03:30:00");
    expect(occurrences[1]?.instantIso).toBe("2026-03-08T07:30:00.000Z");
    expect(occurrences[2]?.instantIso).toBe("2026-03-09T06:30:00.000Z");
  });

  it("uses the first fold for a fall-back recurrence", () => {
    const occurrences = listOccurrences(
      {
        rrule: "FREQ=DAILY;COUNT=2",
        dtstartLocal: "2026-10-31T01:30:00",
        timezone: NY,
      },
      2,
    );
    expect(occurrences[0]?.instantIso).toBe("2026-10-31T05:30:00.000Z");
    expect(occurrences[1]?.local).toBe("2026-11-01T01:30:00");
    expect(occurrences[1]?.instantIso).toBe("2026-11-01T05:30:00.000Z");
  });

  it("all-day recurrence resolves each date with reminder_time_local", () => {
    const occurrences = listOccurrences(
      {
        rrule: "FREQ=DAILY;COUNT=2",
        dtstartLocal: "2026-03-07",
        timezone: NY,
        allDay: true,
        reminderTimeLocal: "02:30:00",
      },
      2,
    );
    expect(occurrences.map((o) => o.occurrenceKey)).toEqual([
      "2026-03-07",
      "2026-03-08",
    ]);
    expect(occurrences[0]?.instantIso).toBe("2026-03-07T07:30:00.000Z");
    expect(occurrences[1]?.wall).toBe("2026-03-08T03:30:00");
    expect(occurrences[1]?.instantIso).toBe("2026-03-08T07:30:00.000Z");
  });
});

describe("schedule vs completion anchors", () => {
  it("completion anchor is max(completed_at, occurrence)", () => {
    const occurrence = "2026-01-31T14:00:00.000Z";
    expect(
      toUtcIso(completionAnchor("2026-01-30T12:00:00.000Z", occurrence)),
    ).toBe(occurrence);
    expect(
      toUtcIso(completionAnchor("2026-02-02T12:00:00.000Z", occurrence)),
    ).toBe("2026-02-02T12:00:00.000Z");
  });

  it("schedule mode advances from the scheduled occurrence", () => {
    const first = listOccurrences(monthly31("last-day"), 1)[0];
    expect(first).toBeDefined();
    const next = nextScheduledOccurrence(monthly31("last-day"), first!.instantIso);
    expect(next?.local).toBe("2026-02-28T09:00:00");
    expect(next?.instantIso).toBe("2026-02-28T14:00:00.000Z");
  });

  it("completion mode advances from an early completion anchor", () => {
    const first = listOccurrences(monthly31("last-day"), 1)[0]!;
    const next = nextCompletionOccurrence(
      monthly31("last-day"),
      first.instantIso,
      "2026-01-30T12:00:00.000Z",
    );
    expect(next?.local).toBe("2026-02-28T09:00:00");
  });

  it("completion mode advances from a late completion anchor", () => {
    const first = listOccurrences(monthly31("last-day"), 1)[0]!;
    const next = nextCompletionOccurrence(
      monthly31("last-day"),
      first.instantIso,
      "2026-02-02T12:00:00.000Z",
    );
    expect(next?.local).toBe("2026-02-28T09:00:00");
  });

  it("completion mode can skip several boundaries when very late", () => {
    const first = listOccurrences(monthly31("last-day"), 1)[0]!;
    const next = nextCompletionOccurrence(
      monthly31("last-day"),
      first.instantIso,
      "2026-03-15T12:00:00.000Z",
    );
    expect(next?.local).toBe("2026-03-31T09:00:00");
  });

  it("skip policy still skips February after an early completion", () => {
    const first = listOccurrences(monthly31("skip"), 1)[0]!;
    const next = nextCompletionOccurrence(
      monthly31("skip"),
      first.instantIso,
      "2026-02-02T12:00:00.000Z",
    );
    expect(next?.local).toBe("2026-03-31T09:00:00");
  });

  it("mode dispatcher validates completion parameters", () => {
    const first = listOccurrences(monthly31("last-day"), 1)[0]!;
    expect(() =>
      nextOccurrenceForMode(monthly31("last-day"), {
        mode: "completion",
        occurrenceInstant: first.instantIso,
      }),
    ).toThrow(/completedAt/);
    expect(
      nextOccurrenceForMode(monthly31("last-day"), {
        mode: "schedule",
        occurrenceInstant: first.instantIso,
      })?.local,
    ).toBe("2026-02-28T09:00:00");
  });
});

describe("generation options and validation", () => {
  it("filters strictly after an instant and respects limit", () => {
    const all = listOccurrences(monthly31("last-day"), 3);
    const after = generateOccurrences(monthly31("last-day"), {
      after: all[0]!.instantIso,
      limit: 2,
    });
    expect(after.map((o) => o.local)).toEqual([
      "2026-02-28T09:00:00",
      "2026-03-31T09:00:00",
    ]);
    expect(
      nextOccurrenceAfter(monthly31("last-day"), all[2]!.instantIso)?.local,
    ).toBe("2026-04-30T09:00:00");
  });

  it("finds the next occurrence of a long-running daily series", () => {
    const daily: RecurrenceInput = {
      rrule: "FREQ=DAILY",
      dtstartLocal: "2020-01-01T09:00:00",
      timezone: "UTC",
    };
    expect(
      nextOccurrenceAfter(daily, "2026-06-01T12:00:00.000Z")?.local,
    ).toBe("2026-06-02T09:00:00");
    expect(
      nextOccurrenceAfter(daily, "2019-12-01T00:00:00.000Z")?.local,
    ).toBe("2020-01-01T09:00:00");
  });

  it("validates recurrence definitions", () => {
    expect(() => assertValidRecurrence(monthly31())).not.toThrow();
    expect(() =>
      assertValidRecurrence({
        rrule: "FREQ=DAILY;TZID=America/New_York",
        dtstartLocal: "2026-01-01T09:00:00",
        timezone: NY,
      }),
    ).toThrow(/TZID/);
    expect(() =>
      assertValidRecurrence({
        rrule: "FREQ=DAILY",
        dtstartLocal: "2026-01-01T09:00:00",
        timezone: "Not/AZone",
      }),
    ).toThrow(/timezone/);
  });

  it("resolving the fold directly confirms first-occurrence semantics", () => {
    const r = resolveWallTime("2026-11-01T01:30:00", NY);
    expect(r.instantIso).toBe("2026-11-01T05:30:00.000Z");
    expect(r.zoned.offset).toBe("-04:00");
  });
});
