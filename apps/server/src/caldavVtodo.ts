/**
 * CalDAV VTODO serializer/parser (v0.3).
 *
 * This module is deliberately pure: it serializes a task row to one VCALENDAR
 * resource containing exactly one VTODO, and parses the VTODO subset that
 * Thunderbird Tasks, DAVx5/Tasks.org, and similar clients send. Recurrence
 * exceptions use `RECURRENCE-ID`; EXDATE-sourced cancellations are emitted on
 * the base series and removed when the client drops the line.
 *
 * Timezone scope: timed values with a real IANA timezone are emitted as
 * `TZID` plus a matching `VTIMEZONE`; UTC tasks stay as `Z`. Parsing accepts
 * UTC (`Z`), floating values (interpreted as UTC, documented), and IANA
 * `TZID` wall times, which are resolved to the correct UTC instant. Unknown
 * zones are rejected instead of silently shifting the time.
 */
import {
  isValidTimeZone,
  resolveWallTime,
  wallDateTimeInZone,
} from "@morrow/shared";
import { buildVtimezone, utcTimezone } from "./vtimezone.js";

export const CALDAV_PRODID = "-//Morrow//Reminders//EN";

export interface CalDavTask {
  id: string;
  ical_uid: string | null;
  caldav_href: string | null;
  title: string;
  notes: string | null;
  status: string;
  priority: number;
  due_at: string | null;
  due_date: string | null;
  all_day: number | boolean;
  timezone: string | null;
  remind_at: string | null;
  reminder_time_local: string | null;
  remind_offset_minutes: number | null;
  dtstart_local: string | null;
  next_occurrence_at: string | null;
  next_occurrence_local: string | null;
  rrule: string | null;
  recurrence_until_date: string | null;
  recurrence_count: number | null;
  completed_at: string | null;
  /** JSON array of live attachments, populated by the CalDAV queries. */
  attachments_json?: string | null;
  /** JSON array of EXDATE-sourced cancelled recurrence ids (base resources). */
  exdates_json?: string | null;
  /** Present on an overridden occurrence resource. Canonical date or UTC ISO. */
  recurrence_id?: string | null;
  recurrence_range?: string | null;
  rev: number;
  created_at: string;
  updated_at: string;
}

export interface CalDavAttachment {
  id: string;
  filename: string;
  mimeType: string;
  bytes: number;
}

export interface CalDavTag {
  name: string;
}

/**
 * Morrow priority (0 = none, 1 = low … 4 = highest) → iCalendar 0–9.
 * Documented and stable; the reverse mapping is intentionally conservative
 * (several iCal values collapse to one Morrow bucket).
 */
export const MORROW_TO_ICAL_PRIORITY: Readonly<Record<number, number>> = {
  0: 0,
  1: 9,
  2: 5,
  3: 3,
  4: 1,
};

export function priorityToIcal(priority: number): number {
  const value = Math.max(0, Math.min(4, Math.trunc(priority)));
  return MORROW_TO_ICAL_PRIORITY[value] ?? 0;
}

export function priorityFromIcal(priority: number): number {
  const value = Math.max(0, Math.min(9, Math.trunc(priority)));
  if (value === 0) return 0;
  if (value <= 2) return 4;
  if (value <= 4) return 3;
  if (value <= 5) return 2;
  return 1;
}

export function escapeIcs(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r\n", "\n")
    .replaceAll("\n", "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
}

export function icsDate(isoDate: string): string {
  return isoDate.replaceAll("-", "");
}

export function icsUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = "";
  for (const char of line) {
    if (Buffer.byteLength(current + char, "utf8") > 73) {
      out.push(current);
      current = " " + char;
    } else {
      current += char;
    }
  }
  if (current) out.push(current);
  return out.join("\r\n");
}

export function icalUidFor(task: Pick<CalDavTask, "id" | "ical_uid">): string {
  return task.ical_uid?.trim() || `${task.id}@morrow`;
}

export function caldavHrefFor(
  task: Pick<CalDavTask, "id" | "caldav_href">,
): string {
  return task.caldav_href?.trim() || `${task.id}.ics`;
}

function isAllDay(task: CalDavTask): boolean {
  return (
    task.all_day === 1 ||
    task.all_day === true ||
    (task.due_date !== null && task.due_at === null)
  );
}

function icsWallFromInstant(instant: string, timezone: string): string | null {
  try {
    return wallDateTimeInZone(new Date(instant), timezone).replace(/[-:]/g, "");
  } catch {
    return null;
  }
}

function icsWallFromLocal(wall: string): string {
  return wall.replace(/[-:]/g, "");
}

/**
 * The zone a VTODO should declare on output. UTC/floating tasks keep the
 * previous UTC representation; a real non-UTC zone is used only when the
 * component actually carries a timed value that needs it.
 */
export function icalTimezoneForTask(task: CalDavTask): string | null {
  if (!task.timezone || utcTimezone(task.timezone)) return null;
  if (!isValidTimeZone(task.timezone)) return null;
  const allDay = isAllDay(task);
  const timedDue = !allDay && task.due_at !== null;
  const timedStart =
    !allDay &&
    task.dtstart_local !== null &&
    !/^\d{4}-\d{2}-\d{2}$/.test(task.dtstart_local);
  return timedDue || timedStart ? task.timezone : null;
}

function timezoneWindowForTask(
  task: CalDavTask,
  timezone: string,
): { fromYear: number; toYear: number } {
  const years: number[] = [];
  const addYear = (value: string | null) => {
    if (!value) return;
    const match = /^(\d{4})/.exec(value);
    if (match) years.push(Number.parseInt(match[1] as string, 10));
  };
  addYear(task.dtstart_local);
  addYear(task.due_date);
  addYear(task.recurrence_until_date);
  for (const instant of [
    task.due_at,
    task.next_occurrence_at,
    task.remind_at,
    task.updated_at,
  ]) {
    if (!instant) continue;
    try {
      addYear(wallDateTimeInZone(new Date(instant), timezone));
    } catch {
      // ignore malformed legacy values
    }
  }
  if (years.length === 0) {
    years.push(new Date().getUTCFullYear());
  }
  const from = Math.min(...years) - 1;
  let to = Math.max(...years) + 1;
  // Recurring tasks may be evaluated into the future. Cover a bounded
  // five-year horizon; later dates still get the last known observance.
  if (task.rrule) to = Math.max(to, Math.max(...years) + 5);
  return { fromYear: from, toYear: Math.min(to, from + 19) };
}

export function vtimezoneForTask(task: CalDavTask): string | null {
  const timezone = icalTimezoneForTask(task);
  if (!timezone) return null;
  return buildVtimezone(timezone, timezoneWindowForTask(task, timezone));
}

function utcFromWall(wall: string, timezone: string | null): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(wall)) return null;
  const tz = timezone && isValidTimeZone(timezone) ? timezone : "UTC";
  try {
    return resolveWallTime(
      wall.length === 16 ? `${wall}:00` : wall,
      tz,
    ).instantIso;
  } catch {
    return null;
  }
}

export function attachmentsForTask(task: CalDavTask): CalDavAttachment[] {
  if (!task.attachments_json) return [];
  try {
    const parsed: unknown = JSON.parse(task.attachments_json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): CalDavAttachment[] => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      if (typeof row["id"] !== "string" || typeof row["filename"] !== "string") {
        return [];
      }
      return [
        {
          id: row["id"],
          filename: row["filename"],
          mimeType:
            typeof row["mimeType"] === "string"
              ? row["mimeType"]
              : "application/octet-stream",
          bytes: typeof row["bytes"] === "number" ? row["bytes"] : 0,
        },
      ];
    });
  } catch {
    return [];
  }
}

function icsParamValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]+/g, " ")}"`;
}

function exdateLine(task: CalDavTask, canonical: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(canonical) || isAllDay(task)) {
    return `EXDATE;VALUE=DATE:${icsDate(canonical.slice(0, 10))}`;
  }
  const timezone = icalTimezoneForTask(task);
  if (timezone) {
    const wall = icsWallFromInstant(canonical, timezone);
    if (wall) return `EXDATE;TZID=${timezone}:${wall}`;
  }
  return `EXDATE:${icsUtc(canonical)}`;
}

function exdateLines(task: CalDavTask): string[] {
  // Exceptions carry the base UID but their own RECURRENCE-ID; EXDATE belongs
  // to the series resource only, and only while a recurrence rule exists.
  if (task.recurrence_id || !task.rrule || !task.exdates_json) return [];
  try {
    const parsed: unknown = JSON.parse(task.exdates_json);
    if (!Array.isArray(parsed)) return [];
    const values = [...new Set(
      parsed.filter((value): value is string => typeof value === "string" && value !== ""),
    )].sort();
    return values.map((value) => exdateLine(task, value));
  } catch {
    return [];
  }
}

function recurrenceIdLine(task: CalDavTask): string {
  const canonical = task.recurrence_id as string;
  const range = task.recurrence_range
    ? `;RANGE=${task.recurrence_range}`
    : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(canonical) || isAllDay(task)) {
    return `RECURRENCE-ID${range};VALUE=DATE:${icsDate(canonical.slice(0, 10))}`;
  }
  const timezone = icalTimezoneForTask(task);
  if (timezone) {
    const wall = icsWallFromInstant(canonical, timezone);
    if (wall) {
      return `RECURRENCE-ID${range};TZID=${timezone}:${wall}`;
    }
  }
  return `RECURRENCE-ID${range}:${icsUtc(canonical)}`;
}

/**
 * One VTODO component. No METHOD, no DTEND: DUE is the deadline and
 * DTSTART is emitted only when a real start/recurrence anchor exists.
 */
export function taskToVtodo(task: CalDavTask, tags: CalDavTag[] = []): string {
  const allDay = isAllDay(task);
  const timezone = icalTimezoneForTask(task);
  const lines: string[] = [
    "BEGIN:VTODO",
    `UID:${icalUidFor(task)}`,
    ...(task.recurrence_id
      ? [recurrenceIdLine(task) as string]
      : []),
    `DTSTAMP:${icsUtc(task.updated_at)}`,
    `CREATED:${icsUtc(task.created_at)}`,
    `LAST-MODIFIED:${icsUtc(task.updated_at)}`,
    `SEQUENCE:${Math.max(1, task.rev)}`,
    `SUMMARY:${escapeIcs(task.title)}`,
  ];
  if (task.notes !== null) {
    lines.push(`DESCRIPTION:${escapeIcs(task.notes)}`);
  }

  // DTSTART is optional for a due-only task. For recurring tasks it anchors
  // the series; a real zone is emitted as TZID so wall time survives DST.
  if (task.dtstart_local) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(task.dtstart_local) || allDay) {
      lines.push(
        `DTSTART;VALUE=DATE:${icsDate(task.dtstart_local.slice(0, 10))}`,
      );
    } else if (timezone) {
      lines.push(
        `DTSTART;TZID=${timezone}:${icsWallFromLocal(task.dtstart_local)}`,
      );
    } else {
      const instant = utcFromWall(task.dtstart_local, task.timezone);
      if (instant) lines.push(`DTSTART:${icsUtc(instant)}`);
    }
  } else if (task.rrule && task.next_occurrence_at) {
    lines.push(`DTSTART:${icsUtc(task.next_occurrence_at)}`);
  }

  if (allDay) {
    if (task.due_date) {
      lines.push(`DUE;VALUE=DATE:${icsDate(task.due_date.slice(0, 10))}`);
    }
  } else if (task.due_at) {
    const wall = timezone
      ? icsWallFromInstant(task.due_at, timezone)
      : null;
    lines.push(
      wall
        ? `DUE;TZID=${timezone}:${wall}`
        : `DUE:${icsUtc(task.due_at)}`,
    );
  } else if (task.due_date) {
    // Defensive: a date-only value without all_day still round-trips as DATE.
    lines.push(`DUE;VALUE=DATE:${icsDate(task.due_date.slice(0, 10))}`);
  }

  if (task.status === "done") {
    lines.push("STATUS:COMPLETED");
    lines.push(`COMPLETED:${icsUtc(task.completed_at ?? task.updated_at)}`);
  } else if (task.status === "cancelled") {
    lines.push("STATUS:CANCELLED");
  } else {
    lines.push("STATUS:NEEDS-ACTION");
  }

  lines.push(`PRIORITY:${priorityToIcal(task.priority)}`);

  const categories = tags
    .map((tag) => tag.name.trim())
    .filter((name) => name !== "")
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  if (categories.length > 0) {
    lines.push(`CATEGORIES:${categories.map(escapeIcs).join(",")}`);
  }

  for (const attachment of attachmentsForTask(task)) {
    const mime = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(attachment.mimeType)
      ? attachment.mimeType
      : "application/octet-stream";
    lines.push(
      `ATTACH;FMTTYPE=${mime};FILENAME=${icsParamValue(attachment.filename)}:/caldav/attachments/${encodeURIComponent(attachment.id)}`,
    );
  }

  if (task.rrule) {
    const rule = task.rrule.replace(/^RRULE:/i, "");
    const extra = [
      rule,
      task.recurrence_count ? `COUNT=${task.recurrence_count}` : null,
      task.recurrence_until_date
        ? `UNTIL=${icsDate(task.recurrence_until_date.slice(0, 10))}`
        : null,
    ]
      .filter(Boolean)
      .join(";");
    lines.push(`RRULE:${extra}`);
  }
  lines.push(...exdateLines(task));

  if (task.remind_offset_minutes !== null) {
    const minutes = Math.abs(task.remind_offset_minutes);
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push(`DESCRIPTION:${escapeIcs(task.title)}`);
    lines.push(
      `TRIGGER:${task.remind_offset_minutes <= 0 ? "-" : "+"}PT${minutes}M`,
    );
    lines.push("END:VALARM");
  } else if (task.remind_at) {
    // Absolute trigger, used when the client supplied one and no relative
    // offset is available. Still UTC in this phase.
    lines.push("BEGIN:VALARM");
    lines.push("ACTION:DISPLAY");
    lines.push(`DESCRIPTION:${escapeIcs(task.title)}`);
    lines.push(`TRIGGER;VALUE=DATE-TIME:${icsUtc(task.remind_at)}`);
    lines.push("END:VALARM");
  }

  lines.push("END:VTODO");
  return lines.map(foldLine).join("\r\n");
}

/** A single calendar object resource: VCALENDAR + exactly one VTODO, no METHOD. */
export function calendarObjectForTask(
  task: CalDavTask,
  tags: CalDavTag[] = [],
): string {
  // taskToVtodo already folds each content line; folding the whole component
  // again would corrupt its internal CRLFs.
  const timezone = vtimezoneForTask(task);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${CALDAV_PRODID}`,
    "CALSCALE:GREGORIAN",
    ...(timezone ? [timezone] : []),
    taskToVtodo(task, tags),
    "END:VCALENDAR",
  ].join("\r\n");
}

/** Multi-task subscribed feed. This is not a CalDAV resource. */
export function vtodoFeed(
  tasks: Array<{ task: CalDavTask; tags: CalDavTag[] }>,
  name = "Morrow",
): string {
  // One VTIMEZONE per referenced zone, covering every task's date window.
  const zones = new Map<string, { fromYear: number; toYear: number }>();
  for (const { task } of tasks) {
    const timezone = icalTimezoneForTask(task);
    if (!timezone) continue;
    const window = timezoneWindowForTask(task, timezone);
    const prior = zones.get(timezone);
    zones.set(
      timezone,
      prior
        ? {
            fromYear: Math.min(prior.fromYear, window.fromYear),
            toYear: Math.max(prior.toYear, window.toYear),
          }
        : window,
    );
  }
  const timezoneBlocks: string[] = [];
  for (const [timezone, window] of zones) {
    const block = buildVtimezone(timezone, window);
    if (block) timezoneBlocks.push(block);
  }
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${CALDAV_PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(name)}`,
    ...timezoneBlocks,
    ...tasks.map(({ task, tags }) => taskToVtodo(task, tags)),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export class CalDavIcsError extends Error {
  readonly status: number;
  readonly code: string;
  readonly precondition: string | null;

  constructor(
    code: string,
    message: string,
    status = 400,
    precondition: string | null = "valid-calendar-data",
  ) {
    super(message);
    this.name = "CalDavIcsError";
    this.status = status;
    this.code = code;
    this.precondition = precondition;
  }
}

export interface ParsedDateValue {
  date: string | null;
  instant: string | null;
  tzid: string | null;
  floating: boolean;
}

export interface ParsedAlarm {
  action: string | null;
  triggerMinutes: number | null;
  triggerAt: string | null;
}

export interface ParsedVtodo {
  component: "VTODO";
  /** VCALENDAR-level METHOD, when a client sends one. CalDAV PUT rejects it. */
  method: string | null;
  uid: string | null;
  summary: string | null;
  description: string | null;
  due: ParsedDateValue | null;
  dtstart: ParsedDateValue | null;
  duration: string | null;
  status: string | null;
  completed: string | null;
  priority: number | null;
  categories: string[] | null;
  sequence: number | null;
  rrule: string | null;
  /** Present on an overridden/exception component (RFC RECURRENCE-ID). */
  recurrenceId: ParsedDateValue | null;
  recurrenceRange: string | null;
  /** Excluded occurrences from EXDATE. */
  exdates: ParsedDateValue[];
  alarms: ParsedAlarm[];
}

export function unfoldIcs(text: string): string[] {
  const raw = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

export function unescapeIcsText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i] as string;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) {
      out += "\\";
      continue;
    }
    i += 1;
    if (next === "n" || next === "N") out += "\n";
    else if (next === ",") out += ",";
    else if (next === ";") out += ";";
    else if (next === "\\") out += "\\";
    else out += `\\${next}`;
  }
  return out;
}

export function splitEscaped(value: string, separator: string): string[] {
  const out: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += `\\${char}`;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === separator) {
      out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  out.push(current);
  return out;
}

function validDateParts(
  y: string,
  mo: string,
  d: string,
  h = "00",
  mi = "00",
  s = "00",
): boolean {
  const year = Number.parseInt(y, 10);
  const month = Number.parseInt(mo, 10);
  const day = Number.parseInt(d, 10);
  const hour = Number.parseInt(h, 10);
  const minute = Number.parseInt(mi, 10);
  const second = Number.parseInt(s, 10);
  if (
    !Number.isFinite(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 60
  ) {
    return false;
  }
  const when = new Date(Date.UTC(year, month - 1, day, hour, minute, Math.min(second, 59)));
  return (
    when.getUTCFullYear() === year &&
    when.getUTCMonth() === month - 1 &&
    when.getUTCDate() === day
  );
}

const TZID_RE = /(?:^|;)TZID=(?:"([^"]+)"|([^;:]+))/i;

export function parseDateValue(
  value: string,
  params: string,
  property: string,
): ParsedDateValue {
  const trimmed = value.trim();
  const tzidMatch = TZID_RE.exec(params);
  const tzid = tzidMatch?.[1] ?? tzidMatch?.[2] ?? null;
  const dateOnly =
    /(?:^|;)VALUE=DATE(?:;|$)/i.test(params) || /^\d{8}$/.test(trimmed);
  if (dateOnly) {
    if (!/^\d{8}$/.test(trimmed)) {
      throw new CalDavIcsError(
        "invalid_calendar_data",
        `${property} must be YYYYMMDD for an all-day value.`,
      );
    }
    const y = trimmed.slice(0, 4);
    const mo = trimmed.slice(4, 6);
    const d = trimmed.slice(6, 8);
    if (!validDateParts(y, mo, d)) {
      throw new CalDavIcsError(
        "invalid_calendar_data",
        `${property} is not a valid date.`,
      );
    }
    return {
      date: `${y}-${mo}-${d}`,
      instant: null,
      tzid,
      floating: false,
    };
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i.exec(
    trimmed,
  );
  if (!match) {
    throw new CalDavIcsError(
      "invalid_calendar_data",
      `${property} must be a UTC date-time, floating date-time, or date.`,
    );
  }
  const [, y, mo, d, h, mi, s, z] = match;
  if (!validDateParts(y as string, mo as string, d as string, h, mi, s)) {
    throw new CalDavIcsError(
      "invalid_calendar_data",
      `${property} is not a valid date-time.`,
    );
  }
  const normalizedTz = tzid?.trim().toUpperCase() ?? null;
  if (
    normalizedTz &&
    normalizedTz !== "UTC" &&
    normalizedTz !== "ETC/UTC" &&
    normalizedTz !== "Z"
  ) {
    if (!tzid || !isValidTimeZone(tzid)) {
      throw new CalDavIcsError(
        "unsupported_tzid",
        `TZID=${tzid ?? ""} is not a known IANA time zone.`,
        400,
        "valid-calendar-data",
      );
    }
    try {
      const resolved = resolveWallTime(
        `${y}-${mo}-${d}T${h}:${mi}:${s}`,
        tzid,
      );
      return {
        date: null,
        instant: resolved.instantIso,
        tzid,
        floating: false,
      };
    } catch {
      throw new CalDavIcsError(
        "unsupported_tzid",
        `TZID=${tzid} could not be resolved.`,
        400,
        "valid-calendar-data",
      );
    }
  }
  const date = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  return {
    date: null,
    instant: date,
    tzid,
    // A floating value is accepted and documented as UTC in this MVP.
    floating: !z && !normalizedTz,
  };
}

export function parseDurationMinutes(value: string): number | null {
  const match =
    /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(
      value.trim(),
    );
  if (!match) return null;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  if (
    weeks === undefined &&
    days === undefined &&
    hours === undefined &&
    minutes === undefined &&
    seconds === undefined
  ) {
    return null;
  }
  const total =
    (Number.parseInt(weeks ?? "0", 10) * 7 +
      Number.parseInt(days ?? "0", 10)) *
      24 *
      60 +
    Number.parseInt(hours ?? "0", 10) * 60 +
    Number.parseInt(minutes ?? "0", 10) +
    Number.parseInt(seconds ?? "0", 10) / 60;
  // The MVP stores alarm triggers with minute precision. Round here so a
  // seconds-bearing TRIGGER can never emit an invalid fractional duration
  // (for example PT1.5M) on the next serialization.
  const rounded = Math.round(total);
  return sign === "-" ? -rounded : rounded;
}

/**
 * Parse exactly one VTODO from a VCALENDAR object. VEVENT is rejected because
 * the CalDAV collection only advertises VTODO. VTIMEZONE blocks and ALARM
 * properties are scoped so a VTIMEZONE DTSTART can never overwrite the task
 * DTSTART (the old flat-parser bug).
 */
export function parseCalDavIcs(text: string): ParsedVtodo {
  const parsed: ParsedVtodo = {
    component: "VTODO",
    method: null,
    uid: null,
    summary: null,
    description: null,
    due: null,
    dtstart: null,
    duration: null,
    status: null,
    completed: null,
    priority: null,
    categories: null,
    sequence: null,
    rrule: null,
    recurrenceId: null,
    recurrenceRange: null,
    exdates: [],
    alarms: [],
  };

  const stack: string[] = [];
  let sawCalendar = false;
  let sawEvent = false;
  let vtodoCount = 0;
  let inVtodo = false;
  let inAlarm = false;
  let alarm: ParsedAlarm = {
    action: null,
    triggerMinutes: null,
    triggerAt: null,
  };

  for (const line of unfoldIcs(text)) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [nameRaw, ...paramParts] = head.split(";");
    const name = (nameRaw ?? "").toUpperCase();
    const params = paramParts.join(";");

    if (name === "BEGIN") {
      const component = value.trim().toUpperCase();
      stack.push(component);
      if (component === "VCALENDAR") sawCalendar = true;
      else if (component === "VEVENT") sawEvent = true;
      else if (component === "VTODO") {
        vtodoCount += 1;
        inVtodo = true;
      } else if (component === "VALARM" && inVtodo) {
        inAlarm = true;
        alarm = { action: null, triggerMinutes: null, triggerAt: null };
      }
      continue;
    }
    if (name === "END") {
      const component = value.trim().toUpperCase();
      if (component === "VALARM" && inAlarm) {
        if (alarm.action !== null || alarm.triggerMinutes !== null || alarm.triggerAt !== null) {
          parsed.alarms.push(alarm);
        }
        inAlarm = false;
      } else if (component === "VTODO") {
        inVtodo = false;
      }
      // Pop to the matching component; malformed nesting is simply ignored.
      const index = stack.lastIndexOf(component);
      if (index >= 0) stack.length = index;
      continue;
    }

    // Ignore properties outside VTODO (and all of VEVENT/VTIMEZONE), but
    // remember a VCALENDAR-level METHOD so the CalDAV route can reject it.
    if (!inVtodo) {
      if (name === "METHOD" && stack.includes("VCALENDAR")) {
        parsed.method = value.trim().toUpperCase() || null;
      }
      continue;
    }
    if (stack.includes("VTIMEZONE")) continue;

    if (inAlarm) {
      if (name === "ACTION") alarm.action = value.trim().toUpperCase();
      else if (name === "TRIGGER") {
        const dateTime = /VALUE=DATE-TIME/i.test(params) ||
          /^\d{8}T\d{6}Z?$/i.test(value.trim());
        if (dateTime) {
          const absolute = parseDateValue(value, params, "TRIGGER");
          alarm.triggerAt = absolute.instant;
        } else {
          const minutes = parseDurationMinutes(value);
          if (minutes !== null) alarm.triggerMinutes = minutes;
        }
      }
      continue;
    }

    if (name === "UID") parsed.uid = unescapeIcsText(value).trim() || null;
    else if (name === "SUMMARY") parsed.summary = unescapeIcsText(value).trim();
    else if (name === "DESCRIPTION") {
      parsed.description = unescapeIcsText(value).trim();
    } else if (name === "DTSTART") {
      parsed.dtstart = parseDateValue(value, params, "DTSTART");
    } else if (name === "DUE") {
      parsed.due = parseDateValue(value, params, "DUE");
    } else if (name === "DURATION") {
      parsed.duration = value.trim();
    } else if (name === "STATUS") {
      parsed.status = value.trim().toUpperCase();
    } else if (name === "COMPLETED") {
      const completed = parseDateValue(value, params, "COMPLETED");
      parsed.completed =
        completed.instant ??
        (completed.date ? `${completed.date}T00:00:00.000Z` : null);
    } else if (name === "PRIORITY") {
      const priority = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(priority)) {
        parsed.priority = Math.max(0, Math.min(9, priority));
      }
    } else if (name === "CATEGORIES") {
      const names = splitEscaped(value, ",")
        .map((entry) => unescapeIcsText(entry).trim())
        .filter((entry) => entry !== "");
      parsed.categories = [...(parsed.categories ?? []), ...names];
    } else if (name === "SEQUENCE") {
      const sequence = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(sequence) && sequence >= 0) {
        parsed.sequence = sequence;
      }
    } else if (name === "RECURRENCE-ID") {
      parsed.recurrenceId = parseDateValue(value, params, "RECURRENCE-ID");
      const range = /RANGE=([A-Z]+)/i.exec(params)?.[1];
      parsed.recurrenceRange = range ? range.toUpperCase() : null;
    } else if (name === "EXDATE") {
      for (const entry of splitEscaped(value, ",")) {
        const trimmedEntry = entry.trim();
        if (trimmedEntry === "") continue;
        parsed.exdates.push(
          parseDateValue(trimmedEntry, params, "EXDATE"),
        );
      }
    } else if (name === "RRULE") {
      parsed.rrule = value.trim();
    }
  }

  if (!sawCalendar) {
    throw new CalDavIcsError(
      "invalid_calendar_data",
      "Body must be a VCALENDAR object.",
    );
  }
  if (sawEvent) {
    throw new CalDavIcsError(
      "vevent_not_supported",
      "This collection only accepts VTODO resources; VEVENT calendars use the read-only /api/calendar.ics feed.",
      403,
      "supported-calendar-component",
    );
  }
  if (vtodoCount === 0) {
    throw new CalDavIcsError(
      "missing_vtodo",
      "VCALENDAR must contain exactly one VTODO.",
    );
  }
  if (vtodoCount > 1) {
    throw new CalDavIcsError(
      "multiple_vtodo",
      "A CalDAV resource must contain exactly one VTODO.",
    );
  }
  if (parsed.due && parsed.duration) {
    throw new CalDavIcsError(
      "due_and_duration",
      "DUE and DURATION are mutually exclusive on a VTODO.",
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Opaque CalDAV entity tags
// ---------------------------------------------------------------------------

export interface EntityTag {
  /** Quoted opaque tag, e.g. `"abc123"`. */
  value: string;
  weak: boolean;
}

export interface ParsedEntityTags {
  wildcard: boolean;
  tags: EntityTag[];
}

/**
 * Parse an If-Match / If-None-Match header without assuming Morrow's REST
 * `"rev-N"` shape. Accepts opaque quoted tags, weak tags, wildcard, and
 * comma-separated lists. Returns null for malformed input.
 */
export function parseEntityTagHeader(
  header: string | string[] | undefined,
): ParsedEntityTags | null {
  if (header === undefined) return null;
  const raw = (Array.isArray(header) ? header.join(",") : header).trim();
  if (raw === "") return null;
  if (raw === "*") return { wildcard: true, tags: [] };

  const tags: EntityTag[] = [];
  let index = 0;
  while (index < raw.length) {
    while (index < raw.length && /[\s,]/.test(raw[index] as string)) {
      index += 1;
    }
    if (index >= raw.length) break;
    let weak = false;
    if (raw.slice(index, index + 2).toUpperCase() === "W/") {
      weak = true;
      index += 2;
    }
    if (raw[index] !== '"') return null;
    const end = raw.indexOf('"', index + 1);
    if (end < 0) return null;
    tags.push({ value: raw.slice(index, end + 1), weak });
    index = end + 1;
    while (index < raw.length && /\s/.test(raw[index] as string)) index += 1;
    if (index < raw.length && raw[index] !== ",") return null;
  }
  if (tags.length === 0) return null;
  return { wildcard: false, tags };
}

export function entityTagMatches(
  parsed: ParsedEntityTags,
  current: string,
  allowWeak = false,
): boolean {
  if (parsed.wildcard) return true;
  return parsed.tags.some(
    (tag) => (allowWeak || !tag.weak) && tag.value === current,
  );
}
