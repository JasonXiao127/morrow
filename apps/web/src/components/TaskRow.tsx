import { useRef, useState, type TouchEvent as ReactTouchEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronRight,
  Clock3,
  Cloud,
  FileText,
  Flag,
  MoreHorizontal,
  Repeat2,
  SkipForward,
  Trash2,
} from "lucide-react";
import type { Task, TaskList } from "@/api";
import {
  formatTime,
  isDoneTask,
  isPendingSyncTask,
  isTaskOverdue,
  isTaskSnoozed,
  listColorSlug,
  listDisplayName,
  recurrenceLabel,
  snoozeUntilLabel,
  taskList,
  taskTimeLabel,
} from "@/lib/format";
import { useDeleteTask, useTaskActions } from "@/lib/queries";
import { inMinutes, snoozeLabel, tomorrowAtNine } from "@/lib/schedule";
import { cn } from "@/lib/utils";
import { DialogFrame } from "./DialogFrame";
import { useShell } from "./shell-context";

const SWIPE_THRESHOLD = 64;

export function TaskRow({
  task,
  lists,
  showList = false,
}: {
  task: Task;
  lists: TaskList[];
  showList?: boolean;
}) {
  const navigate = useNavigate();
  const { complete, snooze, skip, completing, snoozing } = useTaskActions();
  const deleteTask = useDeleteTask();
  const { selectedTaskId, selectTask } = useShell();
  const done = isDoneTask(task);
  const overdue = isTaskOverdue(task);
  const snoozed = isTaskSnoozed(task);
  const list = taskList(task, lists);
  const selected = selectedTaskId === task.id;
  const time = taskTimeLabel(task);
  const recurrence = recurrenceLabel(task.rrule);
  const highPriority =
    task.priority === "high" || task.priority === 3 || task.priority === 2;
  const pendingSync = isPendingSyncTask(task);
  const [swipeX, setSwipeX] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const touch = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);

  const openDetails = () => {
    void navigate({ to: "/tasks/$taskId", params: { taskId: task.id } });
  };

  const onTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (done) return;
    const point = event.touches[0];
    if (!point) return;
    touch.current = { x: point.clientX, y: point.clientY, active: true };
  };

  const onTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    const start = touch.current;
    const point = event.touches[0];
    if (!start?.active || !point) return;
    const dx = point.clientX - start.x;
    const dy = point.clientY - start.y;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
      touch.current = null;
      setSwipeX(0);
      return;
    }
    if (Math.abs(dx) > 8) {
      setSwipeX(Math.max(-140, Math.min(140, dx)));
    }
  };

  const onTouchEnd = () => {
    const start = touch.current;
    touch.current = null;
    if (!start?.active) return;
    const dx = swipeX;
    setSwipeX(0);
    if (Math.abs(dx) >= SWIPE_THRESHOLD) {
      // A completed swipe must not also count as a tap/selection.
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 400);
      if (dx > 0) complete(task);
      else snooze(task, inMinutes(60));
    }
  };

  return (
    <>
      <div className="relative overflow-hidden border-b border-hairline last:border-b-0">
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-between px-4 text-12 font-medium"
          aria-hidden="true"
        >
          <span
            className={cn(
              "flex items-center gap-1.5 text-success transition-opacity",
              swipeX > 12 ? "opacity-100" : "opacity-0",
            )}
          >
            <Check className="h-4 w-4" /> Done
          </span>
          <span
            className={cn(
              "flex items-center gap-1.5 text-warning transition-opacity",
              swipeX < -12 ? "opacity-100" : "opacity-0",
            )}
          >
            <Clock3 className="h-4 w-4" /> Snooze 1h
          </span>
        </div>
        <div
          data-task-id={task.id}
          data-selected={selected || undefined}
          className={cn(
            "group flex touch-pan-y items-stretch gap-0.5 bg-canvas px-1 transition-colors",
            selected ? "bg-accent-soft/50" : "hover:bg-selection/60",
          )}
          style={
            swipeX !== 0
              ? {
                  transform: `translateX(${swipeX}px)`,
                  transition: "none",
                }
              : { transform: "translateX(0)", transition: "transform 160ms ease" }
          }
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={() => {
            touch.current = null;
            setSwipeX(0);
          }}
          onClickCapture={(event) => {
            if (!suppressClick.current) return;
            event.preventDefault();
            event.stopPropagation();
            suppressClick.current = false;
          }}
        >
          <button
            type="button"
            className="task-check"
            aria-label={done ? `Completed: ${task.title}` : `Complete: ${task.title}`}
            aria-pressed={done}
            disabled={done || completing}
            aria-busy={completing}
            onClick={(event) => {
              event.stopPropagation();
              complete(task);
            }}
          >
            <span className={done ? "border-accent bg-accent text-accent-ink" : undefined}>
              {done ? (
                <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
              ) : null}
            </span>
          </button>

          <button
            type="button"
            className="flex min-h-11 min-w-0 flex-1 flex-col justify-center py-2 pr-2 text-left"
            onClick={() => selectTask(task.id)}
            aria-current={selected ? "true" : undefined}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {highPriority ? (
                <Flag
                  className="h-3 w-3 shrink-0 fill-accent text-accent"
                  aria-label="High priority"
                />
              ) : null}
              <span
                className={cn(
                  "truncate text-15",
                  done ? "text-faint line-through" : "text-ink",
                )}
              >
                {task.title}
              </span>
              {pendingSync ? (
                <Cloud
                  className="h-3 w-3 shrink-0 text-warning"
                  aria-label="Saved on this device, not synced yet"
                />
              ) : null}
              {task.notes ? (
                <FileText
                  className="h-3 w-3 shrink-0 text-faint"
                  aria-label="Has notes"
                />
              ) : null}
            </span>
            {time || (showList && list) || recurrence || snoozed ? (
              <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-12 text-muted">
                {time ? (
                  <span className={cn("mono text-12", overdue && !done && "text-danger")}>
                    {time}
                  </span>
                ) : null}
                {snoozed ? (
                  <span className="inline-flex items-center gap-1 text-12 text-warning">
                    <Clock3 className="h-3 w-3" aria-hidden="true" />
                    Snoozed {snoozeUntilLabel(task)}
                  </span>
                ) : null}
                {overdue && !done ? (
                  <span className="text-12 font-medium text-danger">Overdue</span>
                ) : null}
                {recurrence ? (
                  <span className="inline-flex items-center gap-1 text-12 text-muted">
                    <Repeat2 className="h-3 w-3" aria-hidden="true" />
                    {recurrence}
                  </span>
                ) : null}
                {showList && list ? (
                  <span
                    className="inline-flex min-w-0 items-center gap-1.5 text-12 text-muted"
                    data-list-color={listColorSlug(list.color)}
                  >
                    <span className="list-dot" aria-hidden="true" />
                    <span className="truncate">{listDisplayName(list)}</span>
                  </span>
                ) : null}
              </span>
            ) : null}
          </button>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="icon-btn my-auto h-11 w-11 opacity-60 group-hover:opacity-100 data-[state=open]:opacity-100"
                aria-label={`Actions for ${task.title}`}
              >
                <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className="z-[60] min-w-52 rounded-md border border-hairline bg-canvas p-1 text-13 text-ink shadow-lg"
              >
                <DropdownMenu.Item
                  onSelect={openDetails}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 outline-none data-[highlighted]:bg-selection"
                >
                  <ChevronRight className="h-4 w-4 text-muted" aria-hidden="true" />
                  Open details
                </DropdownMenu.Item>
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 outline-none data-[highlighted]:bg-selection data-[state=open]:bg-selection">
                    <Clock3 className="h-4 w-4 text-muted" aria-hidden="true" />
                    Snooze
                    <ChevronRight className="ml-auto h-4 w-4 text-faint" aria-hidden="true" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent
                      sideOffset={4}
                      className="z-[60] min-w-48 rounded-md border border-hairline bg-canvas p-1 text-13 shadow-lg"
                    >
                      {[
                        { label: "10 minutes", until: inMinutes(10) },
                        { label: "1 hour", until: inMinutes(60) },
                        { label: "Tomorrow, 9:00", until: tomorrowAtNine() },
                      ].map((option) => (
                        <DropdownMenu.Item
                          key={option.label}
                          className="min-h-11 cursor-pointer rounded-sm px-2.5 py-2 outline-none data-[highlighted]:bg-selection"
                          onSelect={() => snooze(task, option.until)}
                          disabled={snoozing}
                        >
                          <span>{option.label}</span>
                          <span className="mono ml-3 text-12 text-faint">
                            {snoozeLabel(option.until)}
                          </span>
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
                {task.rrule ? (
                  <DropdownMenu.Item
                    onSelect={() => skip(task)}
                    className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 outline-none data-[highlighted]:bg-selection"
                  >
                    <SkipForward className="h-4 w-4 text-muted" aria-hidden="true" />
                    Skip this occurrence
                  </DropdownMenu.Item>
                ) : null}
                <DropdownMenu.Item
                  onSelect={() => complete(task)}
                  disabled={done || completing}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 outline-none data-[highlighted]:bg-selection data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
                >
                  <Check className="h-4 w-4 text-muted" aria-hidden="true" />
                  Mark done
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
                <DropdownMenu.Item
                  onSelect={() => setConfirmDelete(true)}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 text-danger outline-none data-[highlighted]:bg-danger-soft"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Delete
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      <DialogFrame
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${task.title}`}
        description="The task is soft-deleted on the server."
      >
        <div className="p-5 md:p-6">
          <h2 className="serif text-22">Delete this task?</h2>
          <p className="mt-2 text-13 leading-relaxed text-muted">
            “{task.title}” will be removed from every view. It is soft-deleted,
            but restore it from Recently deleted within 30 days.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={deleteTask.isPending}
              aria-busy={deleteTask.isPending}
              onClick={() => {
                deleteTask.mutate(task, {
                  onSuccess: () => setConfirmDelete(false),
                });
              }}
            >
              {deleteTask.isPending ? "Deleting…" : "Delete task"}
            </button>
          </div>
        </div>
      </DialogFrame>
    </>
  );
}
