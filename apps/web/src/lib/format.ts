import type { Task, TaskList, User } from "@/api";

export { greetingFor, plural } from "./utils";

/**
 * Formatting and task grouping helpers.
 *
 * TODO M1: accept the workspace timezone from bootstrap settings. For now the
 * browser's local timezone is authoritative, which matches the single-user,
 * single-device-timezone case in v0.1.
 */

const longDateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
});

const shortDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
});

const weekdayDateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
});

const monthDayFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "long",
});

const monthYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});

const fullTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function listDisplayName(list: TaskList | null | undefined): string {
  if (!list) return "List";
  return list.name || list.title || "Untitled list";
}

const colorAliases: Record<string, string> = {
  "#b3401a": "persimmon",
  "#e07a4e": "persimmon",
  persimmon: "persimmon",
  orange: "persimmon",
  "#5e6b4a": "moss",
  "#9aac7c": "moss",
  moss: "moss",
  green: "moss",
  "#9a6b1f": "ochre",
  "#d3a463": "ochre",
  ochre: "ochre",
  yellow: "ochre",
  amber: "ochre",
  "#4f6473": "slate",
  "#91aebd": "slate",
  slate: "slate",
  blue: "slate",
  "#6e4a5a": "plum",
  "#c197ad": "plum",
  plum: "plum",
  purple: "plum",
  "#9a4f58": "rose",
  "#d3969d": "rose",
  rose: "rose",
  red: "rose",
  pink: "rose",
};

export function listColorSlug(color: string | null | undefined): string {
  if (!color) return "persimmon";
  return colorAliases[color.toLowerCase()] ?? "persimmon";
}

export function userDisplayName(user: User | null | undefined): string {
  const raw =
    user?.displayName ||
    user?.name ||
    user?.username ||
    user?.email?.split("@")[0] ||
    "You";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function isOpenTask(task: Task): boolean {
  return task.status !== "done" && task.status !== "cancelled";
}

export function isDoneTask(task: Task): boolean {
  return task.status === "done";
}

export function isCancelledTask(task: Task): boolean {
  return task.status === "cancelled";
}

/** A queued offline create that has not reached the server yet. */
export function isPendingSyncTask(task: Task): boolean {
  return task.pendingSync === true;
}

export function isTaskSnoozed(task: Task, now = Date.now()): boolean {
  if (!task.snoozedUntil) return false;
  const until = new Date(task.snoozedUntil).getTime();
  return Number.isFinite(until) && until > now;
}

export function snoozeUntilLabel(task: Task): string | null {
  if (!task.snoozedUntil) return null;
  const until = new Date(task.snoozedUntil);
  if (Number.isNaN(until.getTime())) return null;
  return shortDateTimeFormatter.format(until);
}


export function taskDayKey(task: Task, timeZone?: string): string | null {
  // All-day recurrence advances `nextOccurrenceLocal` as a wall date. Prefer
  // it over the original DTSTART so the task moves to its next date.
  if (task.allDay && task.nextOccurrenceLocal) {
    return task.nextOccurrenceLocal.slice(0, 10);
  }
  if (task.allDay && task.dueDate) return task.dueDate.slice(0, 10);
  const iso = task.nextOccurrenceAt || task.dueAt;
  if (iso) {
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) return dateKeyInZone(date, timeZone);
  }
  if (task.nextOccurrenceLocal) return task.nextOccurrenceLocal.slice(0, 10);
  if (task.dueDate) return task.dueDate.slice(0, 10);
  return null;
}

export function taskInstant(task: Task): Date | null {
  if (task.allDay && task.nextOccurrenceLocal) {
    const parsed = parseDateKey(task.nextOccurrenceLocal.slice(0, 10));
    if (parsed) return parsed;
  }
  const iso = task.nextOccurrenceAt || task.dueAt;
  if (iso) {
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (task.nextOccurrenceLocal) {
    const parsed = parseDateKey(task.nextOccurrenceLocal.slice(0, 10));
    if (parsed) return parsed;
  }
  if (task.dueDate) {
    const parsed = parseDateKey(task.dueDate.slice(0, 10));
    if (parsed) return parsed;
  }
  return null;
}

export function taskHasTime(task: Task): boolean {
  return Boolean(!task.allDay && (task.nextOccurrenceAt || task.dueAt));
}

export function taskTimeLabel(task: Task): string | null {
  if (task.allDay) return "All day";
  const instant = taskInstant(task);
  return instant ? timeFormatter.format(instant) : null;
}

export function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Calendar day in the account timezone. A browser in another zone (travel,
 * headless QA, a server-side browser) must not disagree with the server's
 * `view=today`, which already resolves days in the account timezone.
 */
export function dateKeyInZone(date: Date, timeZone?: string): string {
  if (!timeZone) return dateKey(date);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const get = (type: string): string =>
      parts.find((part) => part.type === type)?.value ?? "";
    const year = get("year");
    const month = get("month");
    const day = get("day");
    return year && month && day ? `${year}-${month}-${day}` : dateKey(date);
  } catch {
    return dateKey(date);
  }
}

export function parseDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function todayKey(now = new Date()): string {
  return dateKey(now);
}

export function todayKeyInZone(timeZone?: string, now = new Date()): string {
  return dateKeyInZone(now, timeZone);
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function isTaskOverdue(task: Task): boolean {
  if (!isOpenTask(task)) return false;
  if (isTaskSnoozed(task)) return false;
  const key = taskDayKey(task);
  const today = todayKey();
  if (key && key < today) return true;
  if (key === today && !task.allDay) {
    const instant = taskInstant(task);
    return Boolean(instant && instant.getTime() < Date.now());
  }
  return false;
}

export function isTaskDueToday(
  task: Task,
  now = new Date(),
  timeZone?: string,
): boolean {
  return taskDayKey(task, timeZone) === todayKeyInZone(timeZone, now);
}

export function isTaskBeforeToday(
  task: Task,
  now = new Date(),
  timeZone?: string,
): boolean {
  const key = taskDayKey(task, timeZone);
  return Boolean(key && key < todayKeyInZone(timeZone, now));
}

export function isTaskAfterToday(
  task: Task,
  now = new Date(),
  timeZone?: string,
): boolean {
  const key = taskDayKey(task, timeZone);
  return Boolean(key && key > todayKeyInZone(timeZone, now));
}

export function sortTasks(a: Task, b: Task): number {
  const aInstant = taskInstant(a);
  const bInstant = taskInstant(b);
  if (aInstant && bInstant) {
    const diff = aInstant.getTime() - bInstant.getTime();
    if (diff !== 0) return diff;
  } else if (aInstant) {
    return -1;
  } else if (bInstant) {
    return 1;
  }
  const aDone = isDoneTask(a) ? 1 : 0;
  const bDone = isDoneTask(b) ? 1 : 0;
  if (aDone !== bDone) return aDone - bDone;
  return a.title.localeCompare(b.title);
}

export interface TaskDayGroup {
  key: string;
  date: Date;
  tasks: Task[];
}

export function groupTasksByDay(
  tasks: Task[],
  timeZone?: string,
): TaskDayGroup[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = taskDayKey(task, timeZone);
    if (!key) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(task);
    else groups.set(key, [task]);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => ({
      key,
      date: parseDateKey(key) ?? new Date(),
      tasks: group.sort(sortTasks),
    }));
}

export function formatLongDate(date: Date, timeZone?: string): string {
  if (!timeZone) return longDateFormatter.format(date);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(date);
  } catch {
    return longDateFormatter.format(date);
  }
}

export function formatShortDate(date: Date): string {
  return monthDayFormatter.format(date);
}

export function formatMonthYear(date: Date, timeZone?: string): string {
  if (!timeZone) return monthYearFormatter.format(date);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "long",
      year: "numeric",
    }).format(date);
  } catch {
    return monthYearFormatter.format(date);
  }
}

export function formatTime(date: Date): string {
  return timeFormatter.format(date);
}

export function formatGroupDate(
  key: string,
  now = new Date(),
  timeZone?: string,
): string {
  const today = todayKeyInZone(timeZone, now);
  if (key === today) return "Today";
  const todayDate = parseDateKey(today);
  if (todayDate && key === dateKey(addDays(todayDate, 1))) return "Tomorrow";
  const date = parseDateKey(key);
  if (!date) return key;
  const diffDays = Math.round(
    (startOfDay(date).getTime() - startOfDay(todayDate ?? now).getTime()) /
      86_400_000,
  );
  if (diffDays > 1 && diffDays < 7) return weekdayFormatter.format(date);
  return weekdayDateFormatter.format(date);
}

export function formatTaskDate(task: Task): string {
  const instant = taskInstant(task);
  if (!instant) return "No date";
  const date = formatShortDate(instant);
  if (task.allDay) return `All day · ${date}`;
  return `${date} · ${formatTime(instant)}`;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : fullTimestampFormatter.format(date);
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  if (diff < 15_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function recurrenceLabel(rrule: string | null | undefined): string | null {
  if (!rrule) return null;
  const intervalMatch = /INTERVAL=(\d+)/i.exec(rrule);
  const interval = intervalMatch ? Number(intervalMatch[1]) : 1;
  const every = interval > 1 ? `Every ${interval} ` : "Every ";
  if (/FREQ=DAILY/i.test(rrule)) return `${every}${interval > 1 ? "days" : "day"}`;
  if (/FREQ=WEEKLY/i.test(rrule)) return `${every}${interval > 1 ? "weeks" : "week"}`;
  if (/FREQ=MONTHLY/i.test(rrule)) return `${every}${interval > 1 ? "months" : "month"}`;
  if (/FREQ=YEARLY/i.test(rrule)) return `${every}${interval > 1 ? "years" : "year"}`;
  return "Repeats";
}

export function taskList(task: Task, lists: TaskList[]): TaskList | null {
  if (!task.listId) return null;
  return lists.find((list) => list.id === task.listId) ?? null;
}

export function taskOccurrenceKey(task: Task): string | undefined {
  // All-day occurrence keys are walls dates, never UTC instants (plan §3).
  if (task.allDay) {
    if (task.nextOccurrenceLocal) return task.nextOccurrenceLocal.slice(0, 10);
    if (task.dueDate) return task.dueDate.slice(0, 10);
    return undefined;
  }
  return (
    task.nextOccurrenceAt ||
    task.dueAt ||
    task.dueDate ||
    undefined
  );
}
