import type { ParsedCapture, Task, UpdateTaskInput } from "@/api";
import { dateKey, parseDateKey } from "./format";

export interface RecurrenceOption {
  id: string;
  label: string;
  rrule: string | null;
}

export const RECURRENCE_OPTIONS: RecurrenceOption[] = [
  { id: "none", label: "Doesn’t repeat", rrule: null },
  { id: "daily", label: "Every day", rrule: "RRULE:FREQ=DAILY" },
  { id: "weekdays", label: "Every weekday", rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
  { id: "weekly", label: "Every week", rrule: "RRULE:FREQ=WEEKLY" },
  { id: "biweekly", label: "Every 2 weeks", rrule: "RRULE:FREQ=WEEKLY;INTERVAL=2" },
  { id: "monthly", label: "Every month", rrule: "RRULE:FREQ=MONTHLY" },
  { id: "yearly", label: "Every year", rrule: "RRULE:FREQ=YEARLY" },
];

export function recurrenceValue(rrule: string | null | undefined): string {
  if (!rrule) return "none";
  const normalized = rrule.toUpperCase().replace(/\s+/g, "");
  const exact = RECURRENCE_OPTIONS.find(
    (option) => option.rrule?.toUpperCase().replace(/\s+/g, "") === normalized,
  );
  if (exact) return exact.id;
  if (/FREQ=DAILY/.test(normalized)) return "daily";
  if (/FREQ=WEEKLY/.test(normalized) && /BYDAY=MO,TU,WE,TH,FR/.test(normalized)) {
    return "weekdays";
  }
  if (/FREQ=WEEKLY/.test(normalized)) return "weekly";
  if (/FREQ=MONTHLY/.test(normalized)) return "monthly";
  if (/FREQ=YEARLY/.test(normalized)) return "yearly";
  return "custom";
}

export function recurrenceLabelForValue(value: string, rrule?: string | null): string {
  if (value === "custom") return rrule ? "Custom repeat" : "Repeat";
  return RECURRENCE_OPTIONS.find((option) => option.id === value)?.label ?? "Doesn’t repeat";
}

export function rruleForValue(value: string, custom?: string | null): string | null {
  if (value === "custom") return custom?.trim() || null;
  return RECURRENCE_OPTIONS.find((option) => option.id === value)?.rrule ?? null;
}

/** `datetime-local` value in the browser's local timezone. */
export function toDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** Format an ISO instant as `datetime-local` in a specific IANA zone. */
export function toDateTimeLocalInZone(
  iso: string | null | undefined,
  timezone: string,
): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const part = (type: string): string =>
      parts.find((entry) => entry.type === type)?.value ?? "";
    const year = part("year");
    const month = part("month");
    const day = part("day");
    const hour = part("hour");
    const minute = part("minute");
    if (!year || !month || !day || !hour || !minute) return toDateTimeLocal(iso);
    return `${year}-${month}-${day}T${hour}:${minute}`;
  } catch {
    return toDateTimeLocal(iso);
  }
}

export function toDateInput(value: string | null | undefined): string {
  if (!value) return "";
  return value.slice(0, 10);
}

/** Local wall datetime with seconds: `YYYY-MM-DDTHH:mm:ss`. */
export function wallDateTimeFromLocal(value: string): string | null {
  if (!value) return null;
  const [datePart, timePart = "00:00"] = value.split("T");
  if (!datePart) return null;
  const time = timePart.length === 5 ? `${timePart}:00` : timePart.slice(0, 8);
  return `${datePart}T${time}`;
}

export function localDateTimeToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Convert a `datetime-local` wall time in a specific IANA zone to a UTC
 * instant. `new Date("YYYY-MM-DDTHH:mm")` interprets the value in the
 * browser's zone, so a browser in UTC would shift a New York user's 09:00
 * reminder by five hours.
 */
export function wallDateTimeInZoneToIso(
  value: string,
  timezone: string,
): string | null {
  if (!value) return null;
  const [datePart, timePart = "00:00"] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const requestedWall = `${datePart}T${timePart.slice(0, 5)}`;

  const partsAt = (
    timestamp: number,
  ): { offset: number; wall: string } | null => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(timestamp));
      const part = (type: string): string =>
        parts.find((entry) => entry.type === type)?.value ?? "";
      const y = part("year");
      const mo = part("month");
      const d = part("day");
      const h = part("hour");
      const mi = part("minute");
      const s = part("second");
      if (!y || !mo || !d || !h || !mi || !s) return null;
      const asIfUtc = Date.UTC(
        Number(y),
        Number(mo) - 1,
        Number(d),
        Number(h),
        Number(mi),
        Number(s),
      );
      if (Number.isNaN(asIfUtc)) return null;
      return {
        offset: asIfUtc - timestamp,
        wall: `${y}-${mo}-${d}T${h}:${mi}`,
      };
    } catch {
      return null;
    }
  };

  // Sample offsets on both sides of the wall time so folds produce both
  // candidates and gaps produce the pre- and post-transition offsets.
  const sampled = [
    wallAsUtc - 86_400_000,
    wallAsUtc,
    wallAsUtc + 86_400_000,
  ]
    .map(partsAt)
    .filter((value): value is { offset: number; wall: string } => value !== null);
  if (sampled.length === 0) return null;

  const offsets = new Set(sampled.map((entry) => entry.offset));
  for (const entry of sampled) {
    const resolved = partsAt(wallAsUtc - entry.offset);
    if (resolved) offsets.add(resolved.offset);
  }

  const candidates = [...offsets]
    .map((offset) => {
      const timestamp = wallAsUtc - offset;
      const parts = partsAt(timestamp);
      return parts ? { timestamp, wall: parts.wall } : null;
    })
    .filter(
      (value): value is { timestamp: number; wall: string } => value !== null,
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  if (candidates.length === 0) return null;
  const exact = candidates.find((entry) => entry.wall === requestedWall);
  if (exact) return new Date(exact.timestamp).toISOString();
  // Spring-forward gap: Temporal's "compatible" policy moves forward.
  const forward = candidates.find((entry) => entry.wall > requestedWall);
  if (forward) return new Date(forward.timestamp).toISOString();
  return new Date(candidates[0]!.timestamp).toISOString();
}

/** A repeat needs a DTSTART; the form must not silently drop the rule. */
export function recurrenceNeedsStart(schedule: {
  rrule?: string | null;
  dueAt?: string | null;
  dueDate?: string | null;
}): boolean {
  return Boolean(schedule.rrule && !schedule.dueAt && !schedule.dueDate);
}

export function localDateKey(value: string): string {
  return value.slice(0, 10);
}

export function addDaysToDateKey(key: string, days: number): string {
  const date = parseDateKey(key);
  if (!date) return key;
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

export function todayDateInput(now = new Date()): string {
  return dateKey(now);
}

export function tomorrowAtNine(now = new Date()): Date {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date;
}

export function inMinutes(minutes: number, now = Date.now()): Date {
  return new Date(now + minutes * 60_000);
}

export interface ScheduleInput {
  /** `datetime-local` for a timed task. */
  dateTimeLocal?: string;
  /** `YYYY-MM-DD` for an all-day task. */
  dateLocal?: string;
  allDay?: boolean;
  rrule?: string | null;
  customRrule?: string | null;
  timezone?: string;
}

/**
 * Build the schedule half of a create/update payload. Clearing the date also
 * clears recurrence, because an occurrence needs a DTSTART.
 */
export function scheduleFields(input: ScheduleInput): UpdateTaskInput {
  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const recurrenceValue = input.rrule ?? "none";
  const rrule = rruleForValue(recurrenceValue, input.customRrule);
  const allDay = Boolean(input.allDay || (!input.dateTimeLocal && input.dateLocal));

  if (allDay && input.dateLocal) {
    return {
      dueAt: null,
      dueDate: input.dateLocal,
      allDay: true,
      timezone,
      rrule,
      dtstartLocal: rrule ? input.dateLocal : null,
    };
  }

  if (input.dateTimeLocal) {
    const dueAt = wallDateTimeInZoneToIso(input.dateTimeLocal, timezone);
    return {
      dueAt,
      dueDate: null,
      allDay: false,
      timezone,
      rrule,
      dtstartLocal: rrule ? wallDateTimeFromLocal(input.dateTimeLocal) : null,
    };
  }

  return {
    dueAt: null,
    dueDate: null,
    allDay: false,
    timezone,
    rrule: null,
    dtstartLocal: null,
  };
}

export interface CaptureSchedule {
  dateTimeLocal: string;
  dateLocal: string;
  allDay: boolean;
  recurrence: string;
  customRrule: string;
}

function dateTimePart(parsed: ParsedCapture, timezone?: string): string {
  if (parsed.dueAt) {
    return timezone
      ? toDateTimeLocalInZone(parsed.dueAt, timezone)
      : toDateTimeLocal(parsed.dueAt);
  }
  if (parsed.dtstartLocal && parsed.dtstartLocal.includes("T")) {
    return parsed.dtstartLocal.slice(0, 16);
  }
  return "";
}

export function captureScheduleFromParsed(
  parsed: ParsedCapture | null,
  timezone?: string,
): CaptureSchedule {
  if (!parsed) return { dateTimeLocal: "", dateLocal: "", allDay: false, recurrence: "none", customRrule: "" };
  const recurrence = recurrenceValue(parsed.rrule);
  return {
    dateTimeLocal: parsed.allDay ? "" : dateTimePart(parsed, timezone),
    dateLocal: parsed.allDay
      ? toDateInput(parsed.dueDate ?? parsed.dtstartLocal)
      : "",
    allDay: Boolean(parsed.allDay || (parsed.dueDate && !parsed.dueAt)),
    recurrence,
    customRrule: recurrence === "custom" ? parsed.rrule ?? "" : "",
  };
}

export function scheduleForTask(
  task: Task,
  timezone?: string,
): CaptureSchedule {
  const recurrence = recurrenceValue(task.rrule);
  if (task.allDay) {
    return {
      dateTimeLocal: "",
      dateLocal: toDateInput(task.nextOccurrenceLocal ?? task.dueDate),
      allDay: true,
      recurrence,
      customRrule: recurrence === "custom" ? task.rrule ?? "" : "",
    };
  }
  const instant = task.nextOccurrenceAt ?? task.dueAt;
  return {
    dateTimeLocal: timezone
      ? toDateTimeLocalInZone(instant, timezone)
      : toDateTimeLocal(instant),
    dateLocal: "",
    allDay: false,
    recurrence,
    customRrule: recurrence === "custom" ? task.rrule ?? "" : "",
  };
}

export function snoozeLabel(until: Date): string {
  const formatter = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return formatter.format(until);
}
