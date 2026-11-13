/**
 * Minimal RFC 5545 VTIMEZONE generation.
 *
 * IANA zone rules are discovered from the runtime's Temporal/Intl data by
 * scanning the relevant year range and binary-searching each offset change.
 * Observances are emitted as explicit onsets (no RRULE), so the block is
 * correct for the dates the task actually carries and bounded in size.
 */
import {
  isValidTimeZone,
  nextTimeZoneTransition,
  wallDateTimeInZone,
} from "@morrow/shared";

export interface VtimezoneOptions {
  /** First year that needs a correct offset. */
  fromYear: number;
  /** Last year that needs a correct offset. */
  toYear: number;
  /** Maximum number of years covered, protects output size. */
  maxYears?: number;
}

interface Transition {
  atMs: number;
  fromMinutes: number;
  toMinutes: number;
}

function isUtcZone(timezone: string): boolean {
  const normalized = timezone.trim().toUpperCase();
  return (
    normalized === "UTC" ||
    normalized === "ETC/UTC" ||
    normalized === "ETC/GMT" ||
    normalized === "GMT" ||
    normalized === "Z"
  );
}

export function utcTimezone(timezone: string | null | undefined): boolean {
  return !timezone || isUtcZone(timezone);
}

/** Offset of `timezone` at an instant, in minutes east of UTC. */
function offsetAt(timezone: string, atMs: number): number {
  const wholeSecond = Math.floor(atMs / 1000) * 1000;
  const wall = wallDateTimeInZone(new Date(wholeSecond).toISOString(), timezone);
  const wallAsUtc = Date.parse(`${wall}Z`);
  return Math.round((wallAsUtc - wholeSecond) / 60_000);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;
}

function localOnset(atMs: number, offsetMinutes: number): string {
  const local = new Date(atMs + offsetMinutes * 60_000)
    .toISOString()
    .slice(0, 19);
  return local.replace(/[-:]/g, "");
}

function findTransitions(
  timezone: string,
  startMs: number,
  endMs: number,
): Transition[] {
  const transitions: Transition[] = [];
  let cursor = startMs;

  // Ask the shared time layer for the next actual offset transition instead
  // of sampling the whole window every six hours. This is the difference
  // between a few calls and tens of thousands for a 20-year window.
  for (let guard = 0; guard < 400; guard += 1) {
    const next = nextTimeZoneTransition(timezone, cursor);
    if (!next || next.atMs > endMs) break;
    if (next.fromOffsetMinutes !== next.toOffsetMinutes) {
      transitions.push({
        atMs: next.atMs,
        fromMinutes: next.fromOffsetMinutes,
        toMinutes: next.toOffsetMinutes,
      });
    }
    cursor = next.atMs;
  }
  return transitions;
}

/**
 * Return a bounded VTIMEZONE block, or null for UTC/fixed-UTC aliases or an
 * unknown zone. The initial observance pins the offset at the window start;
 * each real transition in the window follows.
 */
export function buildVtimezone(
  timezone: string,
  options: VtimezoneOptions,
): string | null {
  if (!timezone || !isValidTimeZone(timezone) || isUtcZone(timezone)) {
    return null;
  }
  const maxYears = Math.max(1, Math.min(50, options.maxYears ?? 20));
  let fromYear = Math.trunc(options.fromYear);
  let toYear = Math.trunc(options.toYear);
  if (!Number.isFinite(fromYear) || !Number.isFinite(toYear)) return null;
  if (toYear < fromYear) [fromYear, toYear] = [toYear, fromYear];
  if (toYear - fromYear > maxYears - 1) toYear = fromYear + maxYears - 1;

  const startYear = Math.max(1, fromYear - 1);
  const endYear = Math.min(9999, toYear + 1);
  const startMs = Date.UTC(startYear, 0, 1, 0, 0, 0);
  const endMs = Date.UTC(endYear, 11, 31, 23, 59, 59);
  const initialOffset = offsetAt(timezone, startMs);
  const transitions = findTransitions(timezone, startMs, endMs);

  const lines: string[] = [
    "BEGIN:VTIMEZONE",
    `TZID:${timezone}`,
    "BEGIN:STANDARD",
    `DTSTART:${startYear}0101T000000`,
    `TZOFFSETFROM:${formatUtcOffset(initialOffset)}`,
    `TZOFFSETTO:${formatUtcOffset(initialOffset)}`,
    "END:STANDARD",
  ];
  for (const transition of transitions) {
    lines.push(
      `BEGIN:${transition.toMinutes > transition.fromMinutes ? "DAYLIGHT" : "STANDARD"}`,
      `DTSTART:${localOnset(transition.atMs, transition.fromMinutes)}`,
      `TZOFFSETFROM:${formatUtcOffset(transition.fromMinutes)}`,
      `TZOFFSETTO:${formatUtcOffset(transition.toMinutes)}`,
      `END:${transition.toMinutes > transition.fromMinutes ? "DAYLIGHT" : "STANDARD"}`,
    );
  }
  lines.push("END:VTIMEZONE");
  return lines.join("\r\n");
}
