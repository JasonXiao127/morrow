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
    const dueAt = localDateTimeToIso(input.dateTimeLocal);
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

function dateTimePart(parsed: ParsedCapture): string {
  if (parsed.dueAt) return toDateTimeLocal(parsed.dueAt);
  if (parsed.dtstartLocal && parsed.dtstartLocal.includes("T")) {
    return parsed.dtstartLocal.slice(0, 16);
  }
  return "";
}

export function captureScheduleFromParsed(parsed: ParsedCapture | null): CaptureSchedule {
  if (!parsed) return { dateTimeLocal: "", dateLocal: "", allDay: false, recurrence: "none", customRrule: "" };
  const recurrence = recurrenceValue(parsed.rrule);
  return {
    dateTimeLocal: parsed.allDay ? "" : dateTimePart(parsed),
    dateLocal: parsed.allDay
      ? toDateInput(parsed.dueDate ?? parsed.dtstartLocal)
      : "",
    allDay: Boolean(parsed.allDay || (parsed.dueDate && !parsed.dueAt)),
    recurrence,
    customRrule: recurrence === "custom" ? parsed.rrule ?? "" : "",
  };
}

export function scheduleForTask(task: Task): CaptureSchedule {
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
  return {
    dateTimeLocal: toDateTimeLocal(task.nextOccurrenceAt ?? task.dueAt),
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
