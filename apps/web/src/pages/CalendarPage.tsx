import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { useShell } from "@/components/shell-context";
import type { Task, TaskList } from "@/api";
import {
  isDoneTask,
  listColorSlug,
  parseDateKey,
  taskDayKey,
  taskList,
  todayKeyInZone,
} from "@/lib/format";
import { useAppData } from "@/lib/queries";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function monthGrid(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function CalendarTask({
  task,
  lists,
  onOpen,
}: {
  task: Task;
  lists: TaskList[];
  onOpen: () => void;
}) {
  const list = taskList(task, lists);
  const done = isDoneTask(task);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onKeyDown={(event) => {
        // The day cell is also an interactive capture target; keep Enter/Space
        // on a task from bubbling into it and opening both surfaces.
        event.stopPropagation();
      }}
      className={cn(
        "flex max-w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left text-[11px] leading-tight transition-colors hover:bg-selection",
        done ? "text-faint line-through" : "text-ink-soft",
      )}
      title={task.title}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70"
        data-list-color={listColorSlug(list?.color)}
        aria-hidden="true"
      />
      <span className="truncate">{task.title}</span>
    </button>
  );
}

export function CalendarPage() {
  const navigate = useNavigate();
  const { openCapture } = useShell();
  const { tasks, lists, user } = useAppData();
  const zone = user?.timezone ?? undefined;
  // Build the wall-calendar month from the account's current day, not the
  // browser's. Around midnight the two can be different dates.
  const today = parseDateKey(todayKeyInZone(zone)) ?? new Date();
  const [anchor, setAnchor] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1),
  );

  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      const key = taskDayKey(task, zone);
      if (!key) continue;
      const bucket = map.get(key);
      if (bucket) bucket.push(task);
      else map.set(key, [task]);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => {
        const aDone = isDoneTask(a) ? 1 : 0;
        const bDone = isDoneTask(b) ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        return a.title.localeCompare(b.title);
      });
    }
    return map;
  }, [tasks, zone]);

  const days = monthGrid(anchor);
  const todayKey = dayKey(today);
  const month = anchor.getMonth();

  const shift = (amount: number) => {
    setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + amount, 1));
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">
      <PageHeader
        eyebrow={<span className="label-caps">Month view</span>}
        title="Calendar"
        description="See the shape of the month. Click a day to capture; click a task to open it."
        actions={
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="icon-btn border border-hairline-strong"
              aria-label="Previous month"
              onClick={() => shift(-1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="btn btn-secondary min-h-9 px-3 text-12"
              onClick={() => setAnchor(new Date(today.getFullYear(), today.getMonth(), 1))}
            >
              Today
            </button>
            <button
              type="button"
              className="icon-btn border border-hairline-strong"
              aria-label="Next month"
              onClick={() => shift(1)}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="btn btn-primary ml-1"
              onClick={() => openCapture()}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add
            </button>
          </div>
        }
      />

      <div className="mt-6 flex items-center justify-between">
        <h2 className="serif text-22">{monthLabel(anchor)}</h2>
        <span className="mono text-11 text-faint">
          {[...byDay.values()]
            .flat()
            .filter((task) => {
              const key = taskDayKey(task, zone);
              return key?.startsWith(
                `${anchor.getFullYear()}-${pad(anchor.getMonth() + 1)}`,
              );
            }).length}{" "}
          scheduled
        </span>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-hairline bg-surface">
        <div className="grid grid-cols-7 border-b border-hairline bg-canvas">
          {WEEKDAYS.map((day) => (
            <div
              key={day}
              className="px-1 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-faint"
            >
              {day}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((date) => {
            const key = dayKey(date);
            const inMonth = date.getMonth() === month;
            const isToday = key === todayKey;
            const dayTasks = byDay.get(key) ?? [];
            return (
              <div
                key={key}
                role="button"
                tabIndex={0}
                onClick={() => openCapture(null, { date: key })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openCapture(null, { date: key });
                  }
                }}
                className={cn(
                  "min-h-[92px] border-b border-r border-hairline p-1.5 align-top transition-colors last:border-r-0 hover:bg-selection/40 focus-visible:bg-selection/40 focus-visible:outline-none md:min-h-[120px]",
                  !inMonth && "bg-canvas/60 text-faint",
                )}
                aria-label={`${key}, ${dayTasks.length} task${dayTasks.length === 1 ? "" : "s"}`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-full text-12 tabular-nums",
                      isToday
                        ? "bg-accent font-semibold text-accent-ink"
                        : inMonth
                          ? "text-ink-soft"
                          : "text-faint",
                    )}
                  >
                    {date.getDate()}
                  </span>
                  {dayTasks.length > 3 ? (
                    <span className="mono text-[10px] text-faint">
                      +{dayTasks.length - 3}
                    </span>
                  ) : null}
                </div>
                <div className="space-y-0.5">
                  {dayTasks.slice(0, 3).map((task) => (
                    <CalendarTask
                      key={task.id}
                      task={task}
                      lists={lists}
                      onOpen={() =>
                        navigate({
                          to: "/tasks/$taskId",
                          params: { taskId: task.id },
                        })
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2 text-12 text-muted">
        <CalendarDays className="h-4 w-4" aria-hidden="true" />
        <span>
          Tasks without a date stay in Inbox and do not appear on the calendar.
        </span>
      </div>
    </div>
  );
}
