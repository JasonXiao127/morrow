import type { Task } from "@/api";
import {
  isOpenTask,
  isTaskSnoozed,
  taskDayKey,
  todayKeyInZone,
} from "./format";

type BadgeNavigator = Navigator & {
  setAppBadge?: (value?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function badgeNavigator(): BadgeNavigator | null {
  if (typeof navigator === "undefined") return null;
  return navigator as BadgeNavigator;
}

/** Count open tasks that are due today or overdue. */
export function dueBadgeCount(
  tasks: readonly Task[],
  now = new Date(),
  timeZone?: string,
): number {
  const today = todayKeyInZone(timeZone, now);
  return tasks.filter((task) => {
    if (!isOpenTask(task) || isTaskSnoozed(task, now.getTime())) return false;
    const day = taskDayKey(task, timeZone);
    return Boolean(day && day <= today);
  }).length;
}

export async function updateAppBadge(
  tasks: readonly Task[],
  now = new Date(),
  timeZone?: string,
): Promise<void> {
  const badge = badgeNavigator();
  if (!badge) return;
  const count = dueBadgeCount(tasks, now, timeZone);
  try {
    if (count > 0) await badge.setAppBadge?.(count);
    else await badge.clearAppBadge?.();
  } catch {
    // Badging is progressive; a denied or unsupported API must not fail the app.
  }
}

export async function clearAppBadge(): Promise<void> {
  const badge = badgeNavigator();
  if (!badge) return;
  try {
    await badge.clearAppBadge?.();
  } catch {
    // Ignore.
  }
}
