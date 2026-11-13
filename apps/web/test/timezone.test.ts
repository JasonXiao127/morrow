import { afterEach, describe, expect, it, vi } from "vitest";
import { localDateTimeToIso } from "../src/lib/schedule.js";
import {
  detectedTimezone,
  localTimeFor,
  timezoneList,
} from "../src/lib/timezone.js";

describe("timezone helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the browser-resolved timezone", () => {
    expect(detectedTimezone()).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    expect(detectedTimezone()).toBeTruthy();
  });

  it("lists the current zone exactly once", () => {
    const zones = timezoneList();
    expect(zones).toContain(detectedTimezone());
    expect(zones.filter((zone) => zone === detectedTimezone())).toHaveLength(
      1,
    );
    expect(new Set(zones).size).toBe(zones.length);
  });

  it("falls back to a short list when supportedValuesOf is unavailable", () => {
    vi.spyOn(Intl, "supportedValuesOf").mockImplementation(() => {
      throw new Error("not supported");
    });

    const expected = Array.from(
      new Set([
        detectedTimezone(),
        "UTC",
        "Europe/London",
        "Europe/Berlin",
        "America/New_York",
        "America/Los_Angeles",
      ]),
    );
    expect(timezoneList()).toEqual(expected);
  });

  it("formats the current time in another zone", () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      timeZone: "Europe/Berlin",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date());
    expect(localTimeFor("Europe/Berlin")).toBe(expected);
  });

  it("returns an em dash for unknown or empty zones", () => {
    expect(localTimeFor("Mars/Olympus")).toBe("—");
    expect(localTimeFor("")).toBe("—");
  });

  it("keeps spring-forward gap times on the post-transition offset", () => {
    expect(localDateTimeToIso("2026-03-08T02:30")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(localDateTimeToIso("2026-03-08T01:30")).toBe(
      "2026-03-08T06:30:00.000Z",
    );
  });

  it("keeps fall-back fold times on the first occurrence", () => {
    expect(localDateTimeToIso("2026-11-01T01:30")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(localDateTimeToIso("2026-11-01T02:30")).toBe(
      "2026-11-01T07:30:00.000Z",
    );
  });
});
