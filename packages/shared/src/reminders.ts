/**
 * Reminder arming (§2).
 *
 * A task created with only `dueAt` (timed) or `dueDate` (all-day) must still
 * enqueue a delivery. The scheduler only watches `next_occurrence_at` and
 * `remind_at`, so creation/update derives one of them:
 *
 * - Timed: `remind_at = dueAt + offset` (default 0), unless explicit remindAt.
 * - All-day: resolve `dueDate + reminder_time_local` (default 09:00) in the
 *   task/user timezone to a UTC instant, then apply the offset.
 * - Recurring: first occurrence from the shared engine; timed stores the
 *   occurrence instant, all-day persists a REAL resolved instant for the next
 *   boundary (not null) so the scheduler can select it.
 *
 * Offset semantics: `remindOffsetMinutes` is added to the due instant.
 * `-10` = ten minutes before due. `null` = 0.
 */
import {
  DEFAULT_ALL_DAY_REMINDER_TIME,
  isUtcIso,
  isValidTimeZone,
  isWallDate,
  normalizeWallTime,
  resolveAllDayReminder,
  resolveWallTime,
  toUtcIso,
} from "./time.js";
import { generateOccurrences, type RecurrenceInput } from "./recurrence.js";

export interface ReminderDerivationInput {
  dueAt?: string | null;
  dueDate?: string | null;
  allDay?: boolean;
  timezone?: string | null;
  /** Fallback when task.timezone is null (usually the owner's timezone). */
  fallbackTimezone?: string | null;
  reminderTimeLocal?: string | null;
  remindOffsetMinutes?: number | null;
  /** undefined = caller did not supply a value; null = explicitly cleared. */
  explicitRemindAt?: string | null | undefined;
  rrule?: string | null;
  dtstartLocal?: string | null;
  recurrenceCount?: number | null;
  recurrenceUntilUtc?: string | null;
  recurrenceUntilDate?: string | null;
  wkst?: string | null;
  recurrenceMode?: string | null;
  clampPolicy?: string | null;
}

export interface DerivedReminder {
  /** UTC instant for the reminder, or null when there is no schedule. */
  remindAt: string | null;
  /** UTC instant for the next occurrence (timed + recurring all-day). */
  nextOccurrenceAt: string | null;
  /** Floating wall local for the next occurrence. */
  nextOccurrenceLocal: string | null;
  /** Sequence index for recurring series (0 when not recurring). */
  occurrenceSeq: number;
}

function effectiveTimezone(input: ReminderDerivationInput): string {
  const candidate =
    input.timezone ?? input.fallbackTimezone ?? "UTC";
  return isValidTimeZone(candidate) ? candidate : "UTC";
}

function offsetMinutes(input: ReminderDerivationInput): number {
  const v = input.remindOffsetMinutes;
  if (typeof v !== "number" || !Number.isSafeInteger(v)) return 0;
  if (v < -43_200 || v > 43_200) return 0;
  return v;
}

/** Apply `remindOffsetMinutes` to a UTC instant. */
export function applyReminderOffset(
  instantIso: string,
  offsetMin: number | null | undefined,
): string {
  if (!offsetMin) return instantIso;
  const ms = Date.parse(instantIso);
  if (Number.isNaN(ms)) return instantIso;
  return toUtcIso(new Date(ms + offsetMin * 60_000));
}

function resolveAllDayInstant(
  dueDate: string,
  reminderTimeLocal: string | null | undefined,
  timezone: string,
): string | null {
  try {
    const time = reminderTimeLocal
      ? normalizeWallTime(reminderTimeLocal)
      : DEFAULT_ALL_DAY_REMINDER_TIME;
    return resolveAllDayReminder(dueDate, time, timezone).instantIso;
  } catch {
    return null;
  }
}

function recurrenceInputFor(
  input: ReminderDerivationInput,
  timezone: string,
): RecurrenceInput | null {
  if (!input.rrule || !input.dtstartLocal) return null;
  return {
    rrule: input.rrule,
    dtstartLocal: input.dtstartLocal,
    timezone,
    count: input.recurrenceCount ?? null,
    untilUtc:
      input.recurrenceUntilUtc && isUtcIso(input.recurrenceUntilUtc)
        ? input.recurrenceUntilUtc
        : null,
    untilDate: input.recurrenceUntilDate ?? null,
    wkst: input.wkst ?? null,
    clampPolicy: input.clampPolicy === "last-day" ? "last-day" : "skip",
    allDay: Boolean(input.allDay),
    reminderTimeLocal: input.reminderTimeLocal ?? null,
  };
}

/**
 * Derive `remind_at` / `next_occurrence_*` for a create or a merged update.
 * Pure — persistence and delivery cancellation stay with the caller.
 *
 * Rules:
 * - explicit `remindAt` (including null) always wins when the key was supplied.
 * - recurring series compute the first occurrence, then offset the reminder.
 * - one-off timed uses `dueAt + offset`; one-off all-day resolves the wall
 *   date in the task timezone, then applies the offset.
 * - no schedule → all nulls.
 */
export function deriveReminder(input: ReminderDerivationInput): DerivedReminder {
  const tz = effectiveTimezone(input);
  const offset = offsetMinutes(input);
  const hasExplicit = input.explicitRemindAt !== undefined;
  const explicit: string | null = hasExplicit
    ? (input.explicitRemindAt ?? null)
    : null;

  // Recurring series first — the occurrence owns the schedule.
  const recur = recurrenceInputFor(input, tz);
  if (recur) {
    try {
      const first = generateOccurrences(recur, { limit: 1 })[0];
      if (first) {
        let occurrenceInstant: string;
        let occurrenceLocal: string;
        if (first.allDay) {
          // Persist a real resolved instant for the next all-day boundary so
          // the scheduler (UTC select) can fire it. The wall date stays the
          // occurrence key and the day-key source.
          occurrenceInstant = first.instantIso;
          occurrenceLocal = first.local;
        } else {
          occurrenceInstant = first.instantIso;
          occurrenceLocal = first.wall;
        }
        const remindAt = hasExplicit
          ? explicit
          : applyReminderOffset(occurrenceInstant, offset);
        return {
          remindAt,
          nextOccurrenceAt: occurrenceInstant,
          nextOccurrenceLocal: occurrenceLocal,
          occurrenceSeq: first.index,
        };
      }
    } catch {
      // Fall through to one-off fallbacks; invalid recurrence is validated
      // separately and must not block the rest of the write.
    }
  }

  const allDay = Boolean(input.allDay);
  if (allDay) {
    const dueDate =
      input.dueDate && isWallDate(input.dueDate) ? input.dueDate : null;
    if (!dueDate) {
      return {
        remindAt: hasExplicit ? explicit : null,
        nextOccurrenceAt: null,
        nextOccurrenceLocal: null,
        occurrenceSeq: 0,
      };
    }
    const instant = resolveAllDayInstant(
      dueDate,
      input.reminderTimeLocal,
      tz,
    );
    const remindAt = hasExplicit
      ? explicit
      : instant
        ? applyReminderOffset(instant, offset)
        : null;
    return {
      remindAt,
      nextOccurrenceAt: null,
      // Keep the wall date visible for day-key grouping even for one-shots.
      nextOccurrenceLocal: null,
      occurrenceSeq: 0,
    };
  }

  // Timed one-off.
  const dueAt =
    input.dueAt && isUtcIso(input.dueAt) ? input.dueAt : null;
  if (!dueAt) {
    return {
      remindAt: hasExplicit ? explicit : null,
      nextOccurrenceAt: null,
      nextOccurrenceLocal: null,
      occurrenceSeq: 0,
    };
  }
  return {
    remindAt: hasExplicit ? explicit : applyReminderOffset(dueAt, offset),
    nextOccurrenceAt: null,
    nextOccurrenceLocal: null,
    occurrenceSeq: 0,
  };
}

/** Keys that require reminder recomputation on PATCH/update. */
export const REMINDER_RECOMPUTE_KEYS = new Set([
  "dueAt",
  "dueDate",
  "allDay",
  "timezone",
  "reminderTimeLocal",
  "remindOffsetMinutes",
  "rrule",
  "dtstartLocal",
  "recurrenceUntilUtc",
  "recurrenceUntilDate",
  "recurrenceCount",
  "wkst",
  "recurrenceMode",
  "clampPolicy",
]);

/** True when the patch touches any schedule field. */
export function needsReminderRecompute(patch: Record<string, unknown>): boolean {
  for (const key of Object.keys(patch)) {
    if (REMINDER_RECOMPUTE_KEYS.has(key)) return true;
  }
  return false;
}

/**
 * Re-resolve a stored floating wall time in a new timezone (for timezone
 * changes). Past occurrence keys are untouched by the caller.
 */
export function reResolveReminderForTimezone(
  wallLocal: string,
  newTimezone: string,
  offsetMin: number | null | undefined,
): string | null {
  try {
    const tz = isValidTimeZone(newTimezone) ? newTimezone : "UTC";
    // Wall may be a date (all-day) — resolve at 09:00 is handled by the
    // caller via resolveAllDayReminder; here we handle full datetimes.
    const resolved = resolveWallTime(wallLocal, tz);
    return applyReminderOffset(resolved.instantIso, offsetMin ?? 0);
  } catch {
    return null;
  }
}
