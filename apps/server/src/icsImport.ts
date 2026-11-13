/**
 * ICS file import (v0.3).
 *
 * A file import is deliberately different from a CalDAV PUT:
 * - it accepts many components in one file,
 * - it accepts VEVENT objects and maps their start/end to a task due date,
 * - it reports per-object failures and still imports the valid objects,
 * - it never fetches an ATTACH URL and never writes an attachment.
 *
 * The parser is pure and bounded. The route enforces the byte cap before this
 * module runs; `MAX_UNFOLDED_LINE` and `MAX_COMPONENTS` keep malformed or
 * hostile files from turning into unbounded work.
 */
import {
  CalDavIcsError,
  parseCalDavIcs,
  parseDateValue,
  parseDurationMinutes,
  priorityFromIcal,
  splitEscaped,
  unfoldIcs,
  unescapeIcsText,
  type ParsedAlarm,
  type ParsedDateValue,
} from "./caldavVtodo.js";

export const MAX_ICS_BYTES = 1024 * 1024;
export const MAX_ICS_COMPONENTS = 1000;
export const MAX_UNFOLDED_LINE = 8192;
export const MAX_DESCRIPTION_CHARS = 10_000;

export interface ImportedIcsObject {
  /** 1-based component position in the file. */
  index: number;
  kind: "VTODO" | "VEVENT";
  uid: string | null;
  summary: string | null;
  description: string | null;
  due: ParsedDateValue | null;
  dtstart: ParsedDateValue | null;
  status: string | null;
  completed: string | null;
  priority: number | null;
  categories: string[] | null;
  sequence: number;
  rrule: string | null;
  alarms: ParsedAlarm[];
  warnings: string[];
}

export interface ImportFailure {
  /** 1-based component position in the file. */
  index: number;
  uid: string | null;
  code: string;
  detail: string;
}

export interface ParsedIcsFile {
  objects: ImportedIcsObject[];
  failures: ImportFailure[];
  /** Components that are not VTODO/VEVENT (VJOURNAL, VFREEBUSY, …). */
  ignored: number;
}

interface RawComponent {
  kind: "VTODO" | "VEVENT";
  lines: string[];
  oversized: boolean;
}

interface LineProperty {
  name: string;
  params: string;
  value: string;
}

function propertyOf(line: string): LineProperty | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const [nameRaw, ...paramParts] = head.split(";");
  return {
    name: (nameRaw ?? "").toUpperCase(),
    params: paramParts.join(";"),
    value: line.slice(colon + 1),
  };
}

/** Strip HTML for X-ALT-DESC fallback text. No HTML is ever stored. */
export function htmlToPlainText(html: string): string {
  let text = html
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const value = Number.parseInt(code, 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : "";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.slice(0, MAX_DESCRIPTION_CHARS);
}

function extractComponents(text: string): {
  components: RawComponent[];
  ignored: number;
  sawCalendar: boolean;
} {
  const lines = unfoldIcs(text);
  if (lines.length > MAX_ICS_COMPONENTS * 200) {
    throw new CalDavIcsError(
      "ics_too_large",
      "The calendar file contains too many lines.",
      413,
      "supported-calendar-data",
    );
  }

  const components: RawComponent[] = [];
  let ignored = 0;
  let sawCalendar = false;
  const stack: string[] = [];
  let capture: {
    kind: "VTODO" | "VEVENT";
    depth: number;
    lines: string[];
    oversized: boolean;
  } | null = null;

  for (const line of lines) {
    if (line === "") continue;
    const oversizedLine = line.length > MAX_UNFOLDED_LINE;
    if (oversizedLine && capture === null) continue;
    const property = propertyOf(line);
    if (!property) continue;

    if (property.name === "BEGIN") {
      const component = property.value.trim().toUpperCase();
      if (component === "VCALENDAR") sawCalendar = true;
      stack.push(component);
      if (
        capture === null &&
        (component === "VTODO" || component === "VEVENT") &&
        !stack.includes("VTIMEZONE")
      ) {
        if (components.length >= MAX_ICS_COMPONENTS) {
          throw new CalDavIcsError(
            "too_many_components",
            `A file may contain at most ${MAX_ICS_COMPONENTS} task components.`,
            413,
            "supported-calendar-data",
          );
        }
        capture = {
          kind: component,
          depth: stack.length,
          lines: [line],
          oversized: false,
        };
      } else if (capture !== null) {
        capture.lines.push(line);
        if (oversizedLine) capture.oversized = true;
      } else if (
        component !== "VCALENDAR" &&
        component !== "VTIMEZONE" &&
        component !== "VALARM"
      ) {
        // VJOURNAL/VFREEBUSY/VTODO nested outside a calendar are ignored, not
        // interpreted as tasks.
        ignored += 1;
      }
      continue;
    }

    if (property.name === "END") {
      const component = property.value.trim().toUpperCase();
      if (capture !== null) {
        capture.lines.push(line);
        if (oversizedLine) capture.oversized = true;
      }
      const index = stack.lastIndexOf(component);
      if (index >= 0) stack.length = index;
      if (
        capture !== null &&
        component === capture.kind &&
        stack.length === capture.depth - 1
      ) {
        components.push({
          kind: capture.kind,
          lines: capture.lines,
          oversized: capture.oversized,
        });
        capture = null;
      }
      continue;
    }

    if (capture !== null) {
      capture.lines.push(line);
      if (oversizedLine) capture.oversized = true;
    }
  }

  if (capture !== null) {
    throw new CalDavIcsError(
      "invalid_calendar_data",
      "A component is not closed.",
    );
  }
  if (!sawCalendar) {
    throw new CalDavIcsError(
      "invalid_calendar_data",
      "Body must contain a VCALENDAR object.",
    );
  }
  return { components, ignored, sawCalendar };
}

/** Top-level X-ALT-DESC text, used only when DESCRIPTION is absent. */
function altDescription(lines: string[]): string | null {
  let inAlarm = false;
  for (const line of lines) {
    const property = propertyOf(line);
    if (!property) continue;
    if (property.name === "BEGIN" && property.value.trim().toUpperCase() === "VALARM") {
      inAlarm = true;
      continue;
    }
    if (property.name === "END" && property.value.trim().toUpperCase() === "VALARM") {
      inAlarm = false;
      continue;
    }
    if (inAlarm) continue;
    if (property.name === "X-ALT-DESC") {
      const text = htmlToPlainText(unescapeIcsText(property.value));
      return text || null;
    }
  }
  return null;
}

function hasAttach(lines: string[]): boolean {
  return lines.some((line) => propertyOf(line)?.name === "ATTACH");
}

function subtractDays(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time)) return date;
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

function parseEventComponent(lines: string[]): ImportedIcsObject {
  let uid: string | null = null;
  let summary: string | null = null;
  let description: string | null = null;
  let dtstart: ParsedDateValue | null = null;
  let dtend: ParsedDateValue | null = null;
  let status: string | null = null;
  let priority: number | null = null;
  let categories: string[] | null = null;
  let sequence = 0;
  let rrule: string | null = null;
  let durationMinutes: number | null = null;
  let inAlarm = false;
  const alarms: ParsedAlarm[] = [];
  let alarm: ParsedAlarm = {
    action: null,
    triggerMinutes: null,
    triggerAt: null,
  };

  for (const line of lines) {
    const property = propertyOf(line);
    if (!property) continue;
    const { name, params, value } = property;
    if (name === "BEGIN") {
      if (value.trim().toUpperCase() === "VALARM") {
        inAlarm = true;
        alarm = { action: null, triggerMinutes: null, triggerAt: null };
      }
      continue;
    }
    if (name === "END") {
      if (value.trim().toUpperCase() === "VALARM") {
        if (
          alarm.action !== null ||
          alarm.triggerMinutes !== null ||
          alarm.triggerAt !== null
        ) {
          alarms.push(alarm);
        }
        inAlarm = false;
      }
      continue;
    }
    if (inAlarm) {
      if (name === "ACTION") alarm.action = value.trim().toUpperCase();
      else if (name === "TRIGGER") {
        const dateTime =
          /VALUE=DATE-TIME/i.test(params) ||
          /^\d{8}T\d{6}Z?$/i.test(value.trim());
        if (dateTime) {
          alarm.triggerAt = parseDateValue(value, params, "TRIGGER").instant;
        } else {
          alarm.triggerMinutes = parseDurationMinutes(value);
        }
      }
      continue;
    }

    if (name === "UID") uid = unescapeIcsText(value).trim() || null;
    else if (name === "SUMMARY") summary = unescapeIcsText(value).trim();
    else if (name === "DESCRIPTION") {
      description = unescapeIcsText(value).trim();
    } else if (name === "DTSTART") {
      dtstart = parseDateValue(value, params, "DTSTART");
    } else if (name === "DTEND") {
      dtend = parseDateValue(value, params, "DTEND");
    } else if (name === "DURATION") {
      durationMinutes = parseDurationMinutes(value);
    } else if (name === "STATUS") {
      status = value.trim().toUpperCase();
    } else if (name === "PRIORITY") {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed)) {
        priority = Math.max(0, Math.min(9, parsed));
      }
    } else if (name === "CATEGORIES") {
      const names = splitEscaped(value, ",")
        .map((entry) => unescapeIcsText(entry).trim())
        .filter((entry) => entry !== "");
      categories = [...(categories ?? []), ...names];
    } else if (name === "SEQUENCE") {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed) && parsed >= 0) sequence = parsed;
    } else if (name === "RRULE") {
      rrule = value.trim();
    }
  }

  if (!dtstart) {
    throw new CalDavIcsError(
      "missing_dtstart",
      "A VEVENT must include DTSTART to be imported.",
    );
  }

  const allDay = dtstart.date !== null;
  let due: ParsedDateValue;
  if (allDay) {
    const startDate = (dtstart as ParsedDateValue).date as string;
    let dueDate = startDate;
    if (dtend?.date) {
      // VEVENT DTEND is exclusive for DATE values.
      dueDate =
        dtend.date > startDate ? subtractDays(dtend.date, 1) : startDate;
    }
    due = {
      date: dueDate,
      instant: null,
      tzid: dtstart.tzid,
      floating: false,
    };
  } else {
    let endInstant = dtend?.instant ?? null;
    if (!endInstant && durationMinutes !== null && dtstart.instant) {
      endInstant = new Date(
        Date.parse(dtstart.instant) + durationMinutes * 60_000,
      ).toISOString();
    }
    due = {
      date: null,
      instant: endInstant ?? dtstart.instant,
      tzid: dtend?.tzid ?? dtstart.tzid,
      floating: false,
    };
  }

  const alt = altDescription(lines);
  return {
    index: 0,
    kind: "VEVENT",
    uid,
    summary,
    description: description ?? alt,
    due,
    dtstart,
    status: status === "CANCELLED" ? "CANCELLED" : status,
    completed: null,
    priority,
    categories,
    sequence,
    rrule,
    alarms,
    warnings: hasAttach(lines)
      ? ["ATTACH ignored; file import never fetches or stores attachments."]
      : [],
  };
}

function parseVtodoComponent(lines: string[]): ImportedIcsObject {
  const wrapped = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Morrow import//EN",
    ...lines,
    "END:VCALENDAR",
  ].join("\r\n");
  const parsed = parseCalDavIcs(wrapped);
  const alt = altDescription(lines);
  return {
    index: 0,
    kind: "VTODO",
    uid: parsed.uid,
    summary: parsed.summary,
    description: parsed.description ?? alt,
    due: parsed.due,
    dtstart: parsed.dtstart,
    status: parsed.status,
    completed: parsed.completed,
    priority: parsed.priority,
    categories: parsed.categories,
    sequence: parsed.sequence ?? 0,
    rrule: parsed.rrule,
    alarms: parsed.alarms,
    warnings: hasAttach(lines)
      ? ["ATTACH ignored; file import never fetches or stores attachments."]
      : [],
  };
}

/**
 * Parse a whole .ics file. A failing component is reported and does not stop
 * the rest of the file. A malformed outer VCALENDAR/oversized file is a hard
 * error because the file as a whole cannot be trusted.
 */
export function parseIcsFile(text: string): ParsedIcsFile {
  if (Buffer.byteLength(text, "utf8") > MAX_ICS_BYTES) {
    throw new CalDavIcsError(
      "ics_too_large",
      `The calendar file exceeds the ${MAX_ICS_BYTES} byte import limit.`,
      413,
      "supported-calendar-data",
    );
  }
  const { components, ignored } = extractComponents(text);
  const objects: ImportedIcsObject[] = [];
  const failures: ImportFailure[] = [];

  components.forEach((component, index) => {
    try {
      if (component.oversized) {
        throw new CalDavIcsError(
          "oversized_line",
          "A calendar line exceeds the maximum unfolded length.",
          413,
          "supported-calendar-data",
        );
      }
      // Recurrence overrides/exclusions are separate resources in CalDAV.
      // File import cannot represent that relationship yet; fail the object
      // instead of silently importing the series without its exceptions.
      const recurrenceProperty = component.lines
        .map((line) => propertyOf(line)?.name)
        .find((name) => name === "RECURRENCE-ID" || name === "EXDATE");
      if (recurrenceProperty) {
        throw new CalDavIcsError(
          "recurrence_unsupported",
          `${recurrenceProperty} cannot be imported from an .ics file yet. Import the series through CalDAV or remove the recurrence override/exclusion.`,
          400,
          "supported-calendar-data",
        );
      }
      const parsed =
        component.kind === "VEVENT"
          ? parseEventComponent(component.lines)
          : parseVtodoComponent(component.lines);
      objects.push({ ...parsed, index: index + 1 });
    } catch (err) {
      const known = err instanceof CalDavIcsError;
      const uidLine = component.lines.find(
        (line) => propertyOf(line)?.name === "UID",
      );
      failures.push({
        index: index + 1,
        uid: uidLine ? (propertyOf(uidLine)?.value.trim() ?? null) : null,
        code: known ? err.code : "invalid_calendar_data",
        detail: err instanceof Error ? err.message : "Invalid calendar object.",
      });
    }
  });

  return { objects, failures, ignored };
}

export interface ImportFingerprintParts {
  summary: string | null;
  description: string | null;
  dueDate: string | null;
  dueInstant: string | null;
  dtstartDate: string | null;
  dtstartInstant: string | null;
  status: string;
  completed: string | null;
  priority: number;
  categories: string[];
  rrule: string | null;
  alarmRelative: number | null;
  alarmAbsolute: string | null;
}

/** Compare at the precision the ICS file format can carry (whole seconds). */
export function fingerprintInstant(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed)
    ? value
    : `${Math.floor(parsed / 1000)}s`;
}

export function fingerprintParts(parts: ImportFingerprintParts): string {
  const categories = [...new Set(
    parts.categories
      .map((name) => name.trim().toLocaleLowerCase("en-US"))
      .filter((name) => name !== ""),
  )].sort();
  return JSON.stringify({
    summary: parts.summary?.trim() || null,
    description: parts.description?.trim() || null,
    due: parts.dueDate
      ? { date: parts.dueDate }
      : parts.dueInstant
        ? { instant: fingerprintInstant(parts.dueInstant) }
        : null,
    dtstart: parts.dtstartDate
      ? { date: parts.dtstartDate }
      : parts.dtstartInstant
        ? { instant: fingerprintInstant(parts.dtstartInstant) }
        : null,
    status: parts.status,
    completed: fingerprintInstant(parts.completed),
    priority: parts.priority,
    categories,
    rrule: parts.rrule
      ? parts.rrule.replace(/^RRULE:/i, "").trim()
      : null,
    alarm:
      parts.alarmRelative !== null
        ? { relative: parts.alarmRelative }
        : parts.alarmAbsolute
          ? { absolute: fingerprintInstant(parts.alarmAbsolute) }
          : null,
  });
}

/** Normalized fields used for equal-sequence conflict/idempotency checks. */
export function importFingerprint(object: ImportedIcsObject): string {
  const relative = object.alarms.find(
    (alarm) => alarm.triggerMinutes !== null,
  );
  const absolute = object.alarms.find((alarm) => alarm.triggerAt !== null);
  return fingerprintParts({
    summary: object.summary,
    description: object.description,
    dueDate: object.due?.date ?? null,
    dueInstant: object.due?.instant ?? null,
    dtstartDate: object.dtstart?.date ?? null,
    dtstartInstant: object.dtstart?.instant ?? null,
    status:
      object.status === "COMPLETED"
        ? "done"
        : object.status === "CANCELLED"
          ? "cancelled"
          : "open",
    completed: object.completed,
    priority:
      object.priority === null ? 0 : priorityFromIcal(object.priority),
    categories: object.categories ?? [],
    rrule: object.rrule,
    alarmRelative: relative?.triggerMinutes ?? null,
    alarmAbsolute: absolute?.triggerAt ?? null,
  });
}
