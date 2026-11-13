/**
 * Time helpers for Morrow.
 *
 * Rules (§3):
 *  - Persisted instants are UTC ISO strings with exactly three fractional
 *    digits: `YYYY-MM-DDTHH:MM:SS.sssZ`.
 *  - Wall times are stored without an offset:
 *      timed      `YYYY-MM-DDTHH:mm:ss`
 *      all-day    `YYYY-MM-DD`
 *  - All-day tasks are NEVER stored as UTC midnight. Their reminder instant is
 *    resolved from the user's wall date + reminder time in their timezone.
 *
 * DST policy:
 *  - Use Temporal's `disambiguation: 'compatible'`.
 *  - Spring-forward gap: 02:30 -> 03:30 (the clock jumps forward by the gap).
 *  - Fall-back fold:     01:30 -> the FIRST 01:30 (earlier offset, usually DST).
 *
 * `rrule` is deliberately not used here: it only supplies floating local
 * datetimes. `resolveWallTime` is the single place where a floating wall time
 * becomes an instant.
 */
import { Temporal } from "@js-temporal/polyfill";

export const UTC_ISO_MS_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const WALL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const WALL_TIME_RE = /^\d{2}:\d{2}(?::\d{2})?$/;
export const WALL_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** Default local reminder time for all-day tasks that do not set one. */
export const DEFAULT_ALL_DAY_REMINDER_TIME = "09:00:00";

export type UtcIso = string;
export type WallDate = string;
export type WallTime = string;
export type WallDateTime = string;

/** Anything that unambiguously identifies an instant. */
export type InstantInput = Date | Temporal.Instant | string | number;

export interface ResolvedWallTime {
  /** Actual resolved local wall datetime (02:30 gap -> 03:30). */
  wall: WallDateTime;
  /** The floating wall time that was requested (02:30 in the gap example). */
  requestedWall: WallDateTime;
  /** Resolved instant. */
  instant: Temporal.Instant;
  /** Fixed-millisecond UTC ISO representation of `instant`. */
  instantIso: UtcIso;
  /** Same instant with the IANA zone attached. */
  zoned: Temporal.ZonedDateTime;
}

export interface ResolvedAllDayReminder extends ResolvedWallTime {
  /** `YYYY-MM-DD`; this is also the occurrence key for all-day tasks. */
  date: WallDate;
  occurrenceKey: WallDate;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function isValidTimeZone(timezone: string): boolean {
  if (!timezone || timezone.length > 128) return false;
  try {
    // Intl validates IANA names; Temporal accepts the same names.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function isUtcIso(value: string): boolean {
  if (!UTC_ISO_MS_RE.test(value)) return false;
  try {
    Temporal.Instant.from(value);
    return true;
  } catch {
    return false;
  }
}

export function isWallDate(value: string): boolean {
  if (!WALL_DATE_RE.test(value)) return false;
  try {
    Temporal.PlainDate.from(value);
    return true;
  } catch {
    return false;
  }
}

export function isWallTime(value: string): boolean {
  if (!WALL_TIME_RE.test(value)) return false;
  try {
    Temporal.PlainTime.from(value);
    return true;
  } catch {
    return false;
  }
}

export function isWallDateTime(value: string): boolean {
  if (!WALL_DATE_TIME_RE.test(value)) return false;
  try {
    Temporal.PlainDateTime.from(value);
    return true;
  } catch {
    return false;
  }
}

/** True for either storage form of a task occurrence key (§3). */
export function isOccurrenceKey(value: string): boolean {
  return isWallDate(value) || isUtcIso(value);
}

export const isValidOccurrenceKey = isOccurrenceKey;

export function assertUtcIso(value: string, label = "timestamp"): void {
  if (!isUtcIso(value)) {
    throw new RangeError(
      `${label} must be UTC ISO with fixed milliseconds (YYYY-MM-DDTHH:MM:SS.sssZ)`,
    );
  }
}

export function assertWallDate(value: string, label = "date"): void {
  if (!isWallDate(value)) {
    throw new RangeError(`${label} must be a valid wall date (YYYY-MM-DD)`);
  }
}

export function assertWallTime(value: string, label = "time"): void {
  if (!isWallTime(value)) {
    throw new RangeError(`${label} must be a valid wall time (HH:mm[:ss])`);
  }
}

export function assertWallDateTime(value: string, label = "datetime"): void {
  if (!isWallDateTime(value)) {
    throw new RangeError(
      `${label} must be a valid wall datetime (YYYY-MM-DDTHH:mm:ss)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------

/**
 * Normalize any instant input to the storage form: UTC ISO with exactly three
 * fractional digits. `Date.prototype.toISOString()` is intentionally used
 * because Temporal's default `toString()` omits `.000`.
 */
export function toUtcIso(value: InstantInput): UtcIso {
  const instant = toInstant(value);
  const ms = Number(instant.epochMilliseconds);
  if (!Number.isFinite(ms)) throw new RangeError("invalid instant");
  return new Date(ms).toISOString();
}

export function nowUtcIso(): UtcIso {
  return new Date().toISOString();
}

export function toInstant(value: InstantInput): Temporal.Instant {
  if (value instanceof Temporal.Instant) return value;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new RangeError("invalid Date");
    return Temporal.Instant.fromEpochMilliseconds(value.getTime());
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("invalid epoch milliseconds");
    return Temporal.Instant.fromEpochMilliseconds(value);
  }
  return Temporal.Instant.from(value);
}

export function utcIsoToEpochMilliseconds(value: UtcIso): number {
  assertUtcIso(value);
  return Number(Temporal.Instant.from(value).epochMilliseconds);
}

/** Alias: format any instant as the fixed-millisecond storage form. */
export function formatUtcIso(value: InstantInput): UtcIso {
  return toUtcIso(value);
}

/** Parse the fixed-millisecond storage form into a Temporal.Instant. */
export function parseUtcIso(value: string): Temporal.Instant {
  assertUtcIso(value);
  return Temporal.Instant.from(value);
}

export function compareInstants(a: InstantInput, b: InstantInput): number {
  const aMs = Number(toInstant(a).epochMilliseconds);
  const bMs = Number(toInstant(b).epochMilliseconds);
  return aMs === bMs ? 0 : aMs < bMs ? -1 : 1;
}

export function maxInstant(a: InstantInput, b: InstantInput): Temporal.Instant {
  return compareInstants(a, b) >= 0 ? toInstant(a) : toInstant(b);
}

// ---------------------------------------------------------------------------
// Wall-time normalization
// ---------------------------------------------------------------------------

export function normalizeWallTime(value: string): WallTime {
  assertWallTime(value);
  const time = Temporal.PlainTime.from(value);
  // Force seconds even when the caller supplied only HH:mm.
  return time.toString({ smallestUnit: "second" });
}

export function normalizeWallDateTime(value: string): WallDateTime {
  const dateOnly = isWallDate(value);
  if (!dateOnly && !isWallDateTime(value)) {
    throw new RangeError(
      "wall datetime must be YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss",
    );
  }
  const dt = Temporal.PlainDateTime.from(
    dateOnly ? `${value}T00:00:00` : value,
  );
  return dt.toString({ smallestUnit: "second" });
}

export function normalizeWallDate(value: string): WallDate {
  assertWallDate(value);
  return Temporal.PlainDate.from(value).toString();
}

export function wallDateTimeFrom(date: WallDate, time: WallTime): WallDateTime {
  return `${normalizeWallDate(date)}T${normalizeWallTime(time)}`;
}

export const formatWallDate = normalizeWallDate;
export const formatWallTime = normalizeWallTime;
export const formatWallDateTime = normalizeWallDateTime;

export function splitWallDateTime(value: string): {
  date: WallDate;
  time: WallTime;
} {
  const wall = normalizeWallDateTime(value);
  return { date: wall.slice(0, 10), time: wall.slice(11) };
}

// ---------------------------------------------------------------------------
// Resolve wall -> instant (the only DST boundary)
// ---------------------------------------------------------------------------

/**
 * Resolve a floating wall datetime in an IANA zone.
 *
 * Temporal `compatible`:
 *  - gap  -> move forward by the gap (02:30 -> 03:30)
 *  - fold -> choose the earlier instant (first 01:30)
 */
export function resolveWallTime(
  wall: string,
  timezone: string,
): ResolvedWallTime {
  if (!isValidTimeZone(timezone)) {
    throw new RangeError(`unknown timezone: ${timezone}`);
  }
  const normalized = normalizeWallDateTime(wall);
  const plain = Temporal.PlainDateTime.from(normalized);
  const zoned = plain.toZonedDateTime(timezone, {
    disambiguation: "compatible",
  });
  const instant = zoned.toInstant();
  return {
    wall: zoned.toPlainDateTime().toString({ smallestUnit: "second" }),
    requestedWall: normalized,
    instant,
    instantIso: toUtcIso(instant),
    zoned,
  };
}

export interface TimeZoneTransition {
  atMs: number;
  fromOffsetMinutes: number;
  toOffsetMinutes: number;
}

/**
 * Next IANA offset transition after `epochMs`. Used by VTIMEZONE generation
 * so it can ask Temporal for the actual transition instead of sampling years
 * of six-hour steps. Returns null for UTC/fixed-offset zones or no transition.
 */
export function nextTimeZoneTransition(
  timezone: string,
  epochMs: number,
): TimeZoneTransition | null {
  if (!isValidTimeZone(timezone)) return null;
  try {
    const current = Temporal.Instant.fromEpochMilliseconds(
      epochMs,
    ).toZonedDateTimeISO(timezone);
    const next = current.getTimeZoneTransition("next");
    if (!next) return null;
    return {
      atMs: Number(next.epochMilliseconds),
      fromOffsetMinutes: Math.round(
        Number(current.offsetNanoseconds) / 60_000_000_000,
      ),
      toOffsetMinutes: Math.round(
        Number(next.offsetNanoseconds) / 60_000_000_000,
      ),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve an all-day reminder. The date remains the occurrence key; the
 * instant is the wall date + reminder time in the user's zone. There is no
 * implicit UTC midnight.
 */
export function resolveAllDayReminder(
  date: WallDate,
  reminderTimeLocal: WallTime = DEFAULT_ALL_DAY_REMINDER_TIME,
  timezone = "UTC",
): ResolvedAllDayReminder {
  const normalizedDate = normalizeWallDate(date);
  const wall = wallDateTimeFrom(normalizedDate, reminderTimeLocal);
  const resolved = resolveWallTime(wall, timezone);
  return {
    ...resolved,
    date: normalizedDate,
    occurrenceKey: normalizedDate,
  };
}

/** Alias used by recurrence generation. */
export const resolveWallDate = resolveAllDayReminder;

/**
 * Re-resolve a stored floating wall time after a timezone change. Past
 * occurrence keys stay untouched; only the next instant changes.
 */
export function reResolveWallTime(
  wall: string,
  newTimezone: string,
): ResolvedWallTime {
  return resolveWallTime(wall, newTimezone);
}

// ---------------------------------------------------------------------------
// Instant -> wall (display / occurrence keys)
// ---------------------------------------------------------------------------

export function wallDateTimeInZone(
  instant: InstantInput,
  timezone: string,
): WallDateTime {
  if (!isValidTimeZone(timezone)) {
    throw new RangeError(`unknown timezone: ${timezone}`);
  }
  const dt = toInstant(instant).toZonedDateTimeISO(timezone).toPlainDateTime();
  return dt.toString({ smallestUnit: "second" });
}

export function wallDateInZone(
  instant: InstantInput,
  timezone: string,
): WallDate {
  return wallDateTimeInZone(instant, timezone).slice(0, 10);
}

export function wallTimeInZone(
  instant: InstantInput,
  timezone: string,
): WallTime {
  return wallDateTimeInZone(instant, timezone).slice(11);
}

/** Timed tasks use the UTC instant as their completion/occurrence key. */
export function timedOccurrenceKey(instant: InstantInput): UtcIso {
  return toUtcIso(instant);
}

/** All-day tasks use the wall date, never UTC midnight. */
export function allDayOccurrenceKey(date: WallDate): WallDate {
  return normalizeWallDate(date);
}

export function occurrenceKeyFor(
  allDay: boolean,
  value: InstantInput | WallDate,
): string {
  if (allDay) return allDayOccurrenceKey(String(value));
  return timedOccurrenceKey(value as InstantInput);
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

/** Add whole wall days without ever converting through UTC midnight. */
export function addWallDays(date: WallDate, days: number): WallDate {
  return Temporal.PlainDate.from(normalizeWallDate(date))
    .add({ days })
    .toString();
}

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** First instant of a local civil day. */
export function startOfWallDate(
  date: WallDate,
  timezone: string,
): ResolvedWallTime {
  return resolveWallTime(`${normalizeWallDate(date)}T00:00:00`, timezone);
}

/** Exclusive upper bound: the first instant of the next local day. */
export function endOfWallDateExclusive(
  date: WallDate,
  timezone: string,
): ResolvedWallTime {
  return startOfWallDate(addWallDays(date, 1), timezone);
}
