/**
 * Deterministic plan-my-day generator (plan §6).
 *
 * The v0.1 contract is a proposal, never a direct rewrite: overdue items are
 * moved into today's free slots and unscheduled open tasks get a time. The
 * model can do this through MCP too; this template keeps the feature working
 * when the model is unavailable.
 */
import {
  addWallDays,
  resolveWallTime,
  wallDateInZone,
  wallTimeInZone,
} from "@morrow/shared";
import { newId } from "@morrow/shared";
import type { ProposalOperation, TaskView } from "./types.js";
import { TaskStore } from "./store.js";

export interface PlanMyDayResult {
  summary: string;
  operations: ProposalOperation[];
  considered: number;
  overdue: number;
  dueToday: number;
  unscheduled: number;
  source: "deterministic";
}

function localWallAfterMinutes(
  now: Date,
  timezone: string,
): { date: string; time: string; instant: string } {
  let wall = wallDateTimeInZoneSafe(now, timezone);
  // Keep the plan in the user's waking day; roll to tomorrow morning after
  // 18:00 and to 09:00 when the next quarter lands before 07:00.
  if (wall.time >= "18:00:00") {
    const tomorrow = addWallDays(wall.date, 1);
    wall = { date: tomorrow, time: "09:00:00" };
  } else if (wall.time < "07:00:00") {
    wall = { date: wall.date, time: "09:00:00" };
  }
  const resolved = resolveWallTime(
    `${wall.date}T${wall.time.slice(0, 8)}`,
    timezone,
  );
  return { date: wall.date, time: wall.time, instant: resolved.instantIso };
}

function wallDateTimeInZoneSafe(
  instant: Date,
  timezone: string,
): { date: string; time: string } {
  try {
    return {
      date: wallDateInZone(instant, timezone),
      time: wallTimeInZone(instant, timezone),
    };
  } catch {
    return {
      date: instant.toISOString().slice(0, 10),
      time: instant.toISOString().slice(11, 19),
    };
  }
}

/** Round up to the next quarter hour and leave a 30 minute buffer. */
function nextQuarterInstant(now: Date): string {
  const step = 15 * 60_000;
  const target = Math.ceil((now.getTime() + 30 * 60_000) / step) * step;
  return new Date(target).toISOString();
}

export function buildPlanMyDay(
  store: TaskStore,
  input: { timezone?: string; now?: Date; limit?: number } = {},
): PlanMyDayResult {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? store.timezone();
  const today = wallDateInZone(now, timezone);
  const open = store.listTasks({ status: "open", view: "all", limit: 200 });
  const overdue = open.filter((task) => {
    // A recurring overdue task is anchored by its series; rescheduling it as
    // a one-off would clear its next occurrence. Leave it to the series.
    if (task.rrule) return false;
    if (task.allDay && task.dueDate) return task.dueDate < today;
    if (task.dueAt) return wallDateInZone(task.dueAt, timezone) < today;
    return false;
  });
  const dueToday = open.filter((task) => {
    if (task.allDay && task.dueDate) return task.dueDate === today;
    if (task.dueAt) return wallDateInZone(task.dueAt, timezone) === today;
    return false;
  });
  const unscheduled = open.filter(
    (task) => !task.dueAt && !task.dueDate && !task.rrule,
  );

  const limit = Math.max(1, Math.min(5, input.limit ?? 3));
  const chosen: Array<{ task: TaskView; reason: "overdue" | "unscheduled" }> = [
    ...overdue.slice(0, limit).map((task) => ({ task, reason: "overdue" as const })),
    ...unscheduled
      .slice(0, Math.max(0, limit - overdue.length))
      .map((task) => ({ task, reason: "unscheduled" as const })),
  ].slice(0, limit);

  const operations: ProposalOperation[] = [];
  let cursor = nextQuarterInstant(now);
  let planDate = today;
  for (const [index, item] of chosen.entries()) {
    const slot = localWallAfterMinutes(new Date(cursor), timezone);
    if (index === 0) planDate = slot.date;
    const patch = {
      dueAt: slot.instant,
      dueDate: null,
      allDay: false,
      timezone,
      nextOccurrenceAt: null,
      nextOccurrenceLocal: null,
    };
    operations.push({
      kind: "update_task",
      operationId: newId(),
      taskId: item.task.id,
      baseRev: item.task.rev,
      title: item.task.title,
      patch,
    });
    // Advance 45 minutes for the next item; localWallAfterMinutes rolls over
    // at 18:00 so the plan never proposes late-night work.
    cursor = new Date(new Date(cursor).getTime() + 45 * 60_000).toISOString();
  }

  const summary =
    operations.length === 0
      ? "Nothing needs a time today. The page can stay clear."
      : `Suggested ${operations.length} ${operations.length === 1 ? "small move" : "small moves"} starting ${planDate}. Nothing changed yet.`;
  return {
    summary,
    operations,
    considered: open.length,
    overdue: overdue.length,
    dueToday: dueToday.length,
    unscheduled: unscheduled.length,
    source: "deterministic",
  };
}
