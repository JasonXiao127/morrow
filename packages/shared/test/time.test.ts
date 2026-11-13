import { describe, expect, it } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import {
  addWallDays,
  allDayOccurrenceKey,
  daysInMonth,
  endOfWallDateExclusive,
  initialSortKey,
  isOccurrenceKey,
  isSortKey,
  isUtcIso,
  isWallDate,
  isWallDateTime,
  isWallTime,
  maxInstant,
  normalizeWallTime,
  resolveAllDayReminder,
  resolveWallTime,
  sortKeyAfter,
  sortKeyBefore,
  sortKeyBetween,
  splitWallDateTime,
  startOfWallDate,
  timedOccurrenceKey,
  toUtcIso,
  uuidv7,
  wallDateInZone,
  wallDateTimeFrom,
  wallDateTimeInZone,
  UUID_V7_RE,
} from "../src/index.js";

const NY = "America/New_York";

describe("resolveWallTime — DST policy", () => {
  it("spring-forward gap 02:30 becomes 03:30", () => {
    const r = resolveWallTime("2026-03-08T02:30:00", NY);
    expect(r.wall).toBe("2026-03-08T03:30:00");
    expect(r.instantIso).toBe("2026-03-08T07:30:00.000Z");
    expect(r.zoned.offset).toBe("-04:00");
  });

  it("fall-back fold 01:30 picks the first occurrence", () => {
    const r = resolveWallTime("2026-11-01T01:30:00", NY);
    expect(r.wall).toBe("2026-11-01T01:30:00");
    expect(r.instantIso).toBe("2026-11-01T05:30:00.000Z");
    expect(r.zoned.offset).toBe("-04:00");
  });

  it("resolves ordinary winter/summer times", () => {
    expect(resolveWallTime("2026-01-15T09:00:00", NY).instantIso).toBe(
      "2026-01-15T14:00:00.000Z",
    );
    expect(resolveWallTime("2026-07-15T09:00:00", NY).instantIso).toBe(
      "2026-07-15T13:00:00.000Z",
    );
  });

  it("re-resolves the same wall time after a timezone change", () => {
    const ny = resolveWallTime("2026-06-01T09:00:00", NY);
    const la = resolveWallTime("2026-06-01T09:00:00", "America/Los_Angeles");
    expect(ny.instantIso).not.toBe(la.instantIso);
    expect(ny.wall).toBe("2026-06-01T09:00:00");
    expect(la.wall).toBe("2026-06-01T09:00:00");
  });

  it("rejects unknown zones", () => {
    expect(() => resolveWallTime("2026-01-01T09:00:00", "Mars/Olympus")).toThrow(
      /unknown timezone/,
    );
  });
});

describe("all-day handling", () => {
  it("uses the wall date as the key and a resolved local reminder instant", () => {
    const r = resolveAllDayReminder("2026-03-08", "02:30:00", NY);
    expect(r.occurrenceKey).toBe("2026-03-08");
    expect(r.date).toBe("2026-03-08");
    expect(r.wall).toBe("2026-03-08T03:30:00");
    expect(r.instantIso).toBe("2026-03-08T07:30:00.000Z");
  });

  it("defaults to 09:00 local, never UTC midnight", () => {
    const r = resolveAllDayReminder("2026-03-08", undefined, NY);
    expect(r.wall).toBe("2026-03-08T09:00:00");
    expect(r.instantIso).toBe("2026-03-08T13:00:00.000Z");
    expect(allDayOccurrenceKey("2026-03-08")).toBe("2026-03-08");
  });

  it("start/end of a DST day are 23 hours apart", () => {
    const start = startOfWallDate("2026-03-08", NY);
    const end = endOfWallDateExclusive("2026-03-08", NY);
    expect(start.instantIso).toBe("2026-03-08T05:00:00.000Z");
    expect(end.instantIso).toBe("2026-03-09T04:00:00.000Z");
    const hours =
      Number(end.instant.epochMilliseconds - start.instant.epochMilliseconds) /
      3_600_000;
    expect(hours).toBe(23);
  });
});

describe("time formatting and validation", () => {
  it("formats UTC ISO with fixed milliseconds", () => {
    expect(toUtcIso(new Date("2026-11-02T12:00:00.000Z"))).toBe(
      "2026-11-02T12:00:00.000Z",
    );
    expect(toUtcIso(new Date("2026-11-02T12:00:00.123Z"))).toBe(
      "2026-11-02T12:00:00.123Z",
    );
    expect(toUtcIso(Temporal.Instant.from("2026-11-02T12:00:00Z"))).toBe(
      "2026-11-02T12:00:00.000Z",
    );
    // Offset input is normalized to UTC.
    expect(toUtcIso("2026-11-02T13:00:00+01:00")).toBe(
      "2026-11-02T12:00:00.000Z",
    );
  });

  it("validates the storage forms", () => {
    expect(isUtcIso("2026-11-02T12:00:00.000Z")).toBe(true);
    expect(isUtcIso("2026-11-02T12:00:00Z")).toBe(false);
    expect(isUtcIso("2026-11-02T12:00:00.000+00:00")).toBe(false);
    expect(isUtcIso("2026-02-30T12:00:00.000Z")).toBe(false);
    expect(isWallDate("2026-02-28")).toBe(true);
    expect(isWallDate("2026-02-30")).toBe(false);
    expect(isWallTime("09:00")).toBe(true);
    expect(isWallTime("09:00:00")).toBe(true);
    expect(isWallTime("24:00:00")).toBe(false);
    expect(isWallDateTime("2026-03-08T02:30:00")).toBe(true);
    expect(isWallDateTime("2026-03-08T02:30")).toBe(false);
  });

  it("normalizes and splits wall datetimes", () => {
    expect(normalizeWallTime("09:00")).toBe("09:00:00");
    expect(wallDateTimeFrom("2026-03-08", "02:30")).toBe(
      "2026-03-08T02:30:00",
    );
    expect(splitWallDateTime("2026-03-08T02:30:00")).toEqual({
      date: "2026-03-08",
      time: "02:30:00",
    });
  });

  it("converts instants to wall times in a zone", () => {
    expect(wallDateTimeInZone("2026-03-08T07:30:00.000Z", NY)).toBe(
      "2026-03-08T03:30:00",
    );
    expect(wallDateInZone("2026-11-02T03:00:00.000Z", NY)).toBe("2026-11-01");
    expect(timedOccurrenceKey("2026-03-08T07:30:00.000Z")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(isOccurrenceKey("2026-03-08")).toBe(true);
    expect(isOccurrenceKey("2026-03-08T07:30:00.000Z")).toBe(true);
    expect(isOccurrenceKey("2026-03-08T07:30:00Z")).toBe(false);
  });

  it("adds wall days without UTC-midnight drift", () => {
    expect(addWallDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addWallDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addWallDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it("maxInstant is a stable anchor helper", () => {
    expect(toUtcIso(maxInstant("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"))).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });
});

describe("uuidv7", () => {
  it("matches the v7/variant layout", () => {
    const id = uuidv7();
    expect(id).toMatch(UUID_V7_RE);
    expect(id[14]).toBe("7");
    expect("89ab").toContain(id[19]);
  });

  it("is monotonic when generated in the same millisecond", () => {
    const ids = Array.from({ length: 200 }, () => uuidv7(1_700_000_000_000));
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  it("rejects invalid timestamps", () => {
    expect(() => uuidv7(-1)).toThrow(/timestamp/);
  });
});

describe("fractional sort keys", () => {
  it("produces ordered fixed-width base62 keys", () => {
    const first = initialSortKey();
    const after = sortKeyAfter(first);
    const before = sortKeyBefore(first);
    expect(isSortKey(first)).toBe(true);
    expect(first).toHaveLength(16);
    expect(before < first).toBe(true);
    expect(first < after).toBe(true);
  });

  it("splits between neighbours", () => {
    const a = initialSortKey();
    const c = sortKeyAfter(a);
    const b = sortKeyBetween(a, c);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    expect(sortKeyBetween(null, a) < a).toBe(true);
    expect(sortKeyAfter(c) > c).toBe(true);
  });

  it("can insert repeatedly at the same position", () => {
    let key = initialSortKey();
    const keys = [key];
    for (let i = 0; i < 50; i += 1) {
      key = sortKeyAfter(key);
      keys.push(key);
    }
    for (let i = 1; i < keys.length; i += 1) {
      expect(keys[i] > keys[i - 1]).toBe(true);
    }
  });

  it("refuses invalid or exhausted ranges", () => {
    expect(() => sortKeyBetween("nope", null)).toThrow(/invalid sort key/);
    expect(() =>
      sortKeyBetween("0000000000000000", "0000000000000001"),
    ).toThrow(/exhausted/);
    expect(() => sortKeyBetween("0000000000000001", "0000000000000001")).toThrow();
  });
});
