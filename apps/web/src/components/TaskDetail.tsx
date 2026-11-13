import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowLeft,
  Bell,
  CalendarClock,
  Check,
  ChevronRight,
  Clock3,
  Cloud,
  Flag,
  List as ListIcon,
  MoreHorizontal,
  Pencil,
  Repeat2,
  SkipForward,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { Task, TaskList, UpdateTaskInput } from "@/api";
import {
  formatTaskDate,
  formatTimestamp,
  isDoneTask,
  isPendingSyncTask,
  isTaskOverdue,
  isTaskSnoozed,
  listColorSlug,
  listDisplayName,
  recurrenceLabel,
  snoozeUntilLabel,
  taskList,
} from "@/lib/format";
import {
  useDeleteTask,
  useTaskActions,
  useUpdateTask,
} from "@/lib/queries";
import {
  inMinutes,
  RECURRENCE_OPTIONS,
  recurrenceValue,
  scheduleFields,
  scheduleForTask,
  snoozeLabel,
  toDateTimeLocal,
  tomorrowAtNine,
} from "@/lib/schedule";
import { useUndoState } from "@/lib/undo";
import {
  TASK_FIELD_EVENT,
  type TaskFieldFocusDetail,
} from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { DeliveryLedger } from "./DeliveryLedger";
import { DialogFrame } from "./DialogFrame";
import { Markdown } from "./Markdown";
import {
  AttachmentSection,
  SubtaskSection,
  TaskTagsSection,
} from "./TaskExtras";

export function TaskDetail({
  task,
  lists,
  onClose,
  variant = "inspector",
}: {
  task: Task;
  lists: TaskList[];
  onClose?: () => void;
  variant?: "inspector" | "page";
}) {
  const navigate = useNavigate();
  const { complete, snooze, skip, completing, snoozing, skipping } =
    useTaskActions();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const undo = useUndoState();
  const done = isDoneTask(task);
  const overdue = isTaskOverdue(task);
  const snoozed = isTaskSnoozed(task);
  const pendingSync = isPendingSyncTask(task);
  const list = taskList(task, lists);
  const recurrence = recurrenceLabel(task.rrule);
  const Heading = variant === "page" ? "h1" : "h2";

  const [editing, setEditing] = useState(false);
  // Snapshot the revision at edit start. If SSE/another tab changes the task
  // while this form is open, saving must 412 and show the resolver instead of
  // silently applying to the newest revision.
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [listId, setListId] = useState(task.listId ?? "");
  const [allDay, setAllDay] = useState(Boolean(task.allDay));
  const [dateValue, setDateValue] = useState(
    task.allDay ? (task.dueDate ?? "").slice(0, 10) : toDateTimeLocal(task.dueAt),
  );
  const [recurrenceValueState, setRecurrenceValueState] = useState(
    recurrenceValue(task.rrule),
  );
  const [customRrule, setCustomRrule] = useState(
    recurrenceValue(task.rrule) === "custom" ? task.rrule ?? "" : "",
  );
  const [priority, setPriority] = useState(String(task.priority ?? 0));
  const [repeatEndMode, setRepeatEndMode] = useState<"none" | "date" | "count">(
    task.recurrenceCount != null
      ? "count"
      : task.recurrenceUntilDate
        ? "date"
        : "none",
  );
  const [repeatUntilDate, setRepeatUntilDate] = useState(
    (task.recurrenceUntilDate ?? "").slice(0, 10),
  );
  const [repeatCount, setRepeatCount] = useState(
    task.recurrenceCount != null ? String(task.recurrenceCount) : "10",
  );
  const [remindOffset, setRemindOffset] = useState<string>(() =>
    task.remindOffsetMinutes == null
      ? "0"
      : String(task.remindOffsetMinutes),
  );
  const [customOffset, setCustomOffset] = useState<string>(() =>
    task.remindOffsetMinutes != null &&
    !["0", "-10", "-60", "-1440"].includes(String(task.remindOffsetMinutes))
      ? String(task.remindOffsetMinutes)
      : "",
  );
  const [reminderTime, setReminderTime] = useState<string>(
    (task.reminderTimeLocal ?? "09:00:00").slice(0, 5),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const repeatRef = useRef<HTMLSelectElement>(null);

  // Reset the editor when the selected task identity or revision changes and
  // we are not mid-edit.
  useEffect(() => {
    if (editing) return;
    const schedule = scheduleForTask(task);
    setTitle(task.title);
    setNotes(task.notes ?? "");
    setListId(task.listId ?? "");
    setAllDay(schedule.allDay);
    setDateValue(schedule.allDay ? schedule.dateLocal : schedule.dateTimeLocal);
    setRecurrenceValueState(schedule.recurrence);
    setCustomRrule(schedule.customRrule);
    setPriority(String(task.priority ?? 0));
    setRepeatEndMode(
      task.recurrenceCount != null
        ? "count"
        : task.recurrenceUntilDate
          ? "date"
          : "none",
    );
    setRepeatUntilDate((task.recurrenceUntilDate ?? "").slice(0, 10));
    setRepeatCount(
      task.recurrenceCount != null ? String(task.recurrenceCount) : "10",
    );
    setRemindOffset(
      task.remindOffsetMinutes == null ? "0" : String(task.remindOffsetMinutes),
    );
    setCustomOffset(
      task.remindOffsetMinutes != null &&
        !["0", "-10", "-60", "-1440"].includes(
          String(task.remindOffsetMinutes),
        )
        ? String(task.remindOffsetMinutes)
        : "",
    );
    setReminderTime((task.reminderTimeLocal ?? "09:00:00").slice(0, 5));
  }, [editing, task]);

  // D / R keyboard shortcuts focus the matching field and enter edit mode.
  useEffect(() => {
    const onFocusField = (event: Event) => {
      const detail = (event as CustomEvent<TaskFieldFocusDetail>).detail;
      if (!detail || detail.taskId !== task.id) return;
      if (!editing) {
        setEditingTask(task);
        setEditing(true);
      }
      window.requestAnimationFrame(() => {
        if (detail.field === "repeat") repeatRef.current?.focus();
        else if (detail.field === "date") dateRef.current?.focus();
        else titleRef.current?.focus();
      });
    };
    window.addEventListener(TASK_FIELD_EVENT, onFocusField);
    return () => window.removeEventListener(TASK_FIELD_EVENT, onFocusField);
  }, [editing, task]);

  const beginEdit = (field: "title" | "date" | "repeat" = "title") => {
    if (!editing) setEditingTask(task);
    setEditing(true);
    setFormError(null);
    window.requestAnimationFrame(() => {
      if (field === "repeat") repeatRef.current?.focus();
      else if (field === "date") dateRef.current?.focus();
      else titleRef.current?.focus();
    });
  };

  const save = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setFormError("A task needs a title.");
      titleRef.current?.focus();
      return;
    }
    const schedule = scheduleFields({
      dateTimeLocal: allDay ? "" : dateValue,
      dateLocal: allDay ? dateValue.slice(0, 10) : "",
      allDay,
      rrule: recurrenceValueState,
      customRrule,
    });
    // Reminder offset: preset values or a custom minute count (negative =
    // before due, 0 = at due time). Custom input is validated as an integer
    // in the allowed range.
    let nextOffset: number | null = null;
    if (remindOffset === "custom") {
      const parsed = Number.parseInt(customOffset, 10);
      if (!Number.isSafeInteger(parsed) || parsed < -43_200 || parsed > 43_200) {
        setFormError("Custom reminder offset must be -43200…43200 minutes.");
        return;
      }
      nextOffset = parsed;
    } else {
      const parsed = Number.parseInt(remindOffset, 10);
      nextOffset = Number.isSafeInteger(parsed) ? parsed : 0;
      if (nextOffset === 0) nextOffset = 0;
    }
    // All-day reminder time (HH:mm); stored as HH:mm:00.
    let nextReminderTime: string | null = null;
    if (allDay) {
      const m = /^(\d{2}):(\d{2})$/.exec(reminderTime.trim());
      if (!m) {
        setFormError("Reminder time must be HH:mm.");
        return;
      }
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (hh > 23 || mm > 59) {
        setFormError("Reminder time must be HH:mm.");
        return;
      }
      nextReminderTime = `${m[1]}:${m[2]}:00`;
    }
    // Only send scheduling fields when the user actually changed them. A
    // title-only edit must not reset a recurring series' DTSTART to its next
    // occurrence (or clear an advanced next occurrence).
    const base = scheduleForTask(editingTask ?? task);
    const baseTask = editingTask ?? task;
    const baseOffset = baseTask.remindOffsetMinutes ?? 0;
    const baseReminderTime = (
      baseTask.reminderTimeLocal ??
      "09:00:00"
    ).slice(0, 5);
    const basePriority = baseTask.priority ?? 0;
    const baseRepeatEnd =
      baseTask.recurrenceCount != null
        ? "count"
        : baseTask.recurrenceUntilDate
          ? "date"
          : "none";
    const repeatEndChanged =
      repeatEndMode !== baseRepeatEnd ||
      (repeatEndMode === "date" &&
        repeatUntilDate !== (baseTask.recurrenceUntilDate ?? "").slice(0, 10)) ||
      (repeatEndMode === "count" &&
        repeatCount !==
          (baseTask.recurrenceCount != null
            ? String(baseTask.recurrenceCount)
            : "10"));
    if (repeatEndMode === "date" && !repeatUntilDate) {
      setFormError("Pick an end date, or choose “Never”.");
      return;
    }
    if (
      repeatEndMode === "count" &&
      (!Number.isSafeInteger(Number.parseInt(repeatCount, 10)) ||
        Number.parseInt(repeatCount, 10) < 1)
    ) {
      setFormError("Repeat count must be a whole number of at least 1.");
      return;
    }
    const scheduleChanged =
      allDay !== base.allDay ||
      dateValue !== (base.allDay ? base.dateLocal : base.dateTimeLocal) ||
      recurrenceValueState !== base.recurrence ||
      customRrule !== base.customRrule;
    const reminderChanged =
      (nextOffset ?? 0) !== (baseOffset ?? 0) ||
      (allDay ? reminderTime.trim().slice(0, 5) : null) !==
        (base.allDay ? baseReminderTime : null) ||
      (allDay !== base.allDay && allDay);
    const patch: UpdateTaskInput = {
      title: trimmed,
      notes: notes.trim() ? notes : null,
      listId: listId || null,
    };
    if (Number.parseInt(priority, 10) !== basePriority) {
      patch.priority = Number.parseInt(priority, 10);
    }
    if (scheduleChanged) {
      Object.assign(patch, schedule);
      if (schedule.rrule) {
        patch.nextOccurrenceAt = allDay ? null : schedule.dueAt ?? null;
        patch.nextOccurrenceLocal = schedule.dtstartLocal ?? null;
      } else {
        patch.nextOccurrenceAt = null;
        patch.nextOccurrenceLocal = null;
      }
    }
    if (scheduleChanged || repeatEndChanged) {
      if (!schedule.rrule) {
        patch.recurrenceUntilDate = null;
        patch.recurrenceUntilUtc = null;
        patch.recurrenceCount = null;
      } else if (repeatEndMode === "date") {
        patch.recurrenceUntilDate = repeatUntilDate;
        patch.recurrenceUntilUtc = null;
        patch.recurrenceCount = null;
      } else if (repeatEndMode === "count") {
        patch.recurrenceUntilDate = null;
        patch.recurrenceUntilUtc = null;
        patch.recurrenceCount = Number.parseInt(repeatCount, 10);
      } else {
        patch.recurrenceUntilDate = null;
        patch.recurrenceUntilUtc = null;
        patch.recurrenceCount = null;
      }
    }
    if (reminderChanged || scheduleChanged) {
      patch.remindOffsetMinutes = nextOffset;
      if (allDay) patch.reminderTimeLocal = nextReminderTime;
    }
    setFormError(null);
    try {
      await updateTask.mutateAsync({
        task: editingTask ?? task,
        patch,
        label: "Saved.",
        onResolved: () => {
          setEditing(false);
          setEditingTask(null);
        },
      });
      setEditing(false);
      setEditingTask(null);
    } catch {
      // The mutation surfaces a toast or the conflict resolver.
    }
  };

  const openFullPage = () => {
    void navigate({ to: "/tasks/$taskId", params: { taskId: task.id } });
  };

  const closeAfterDelete = () => {
    setConfirmDelete(false);
    if (onClose) onClose();
    else void navigate({ to: "/today" });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-hairline px-4">
        {variant === "page" ? (
          <Link to="/today" className="btn btn-ghost -ml-2 min-h-11 px-2 text-13">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Today
          </Link>
        ) : (
          <span className="label-caps">Task</span>
        )}
        <span className="ml-auto mono text-12 text-faint">
          {task.id.slice(0, 8)}
        </span>
        {onClose ? (
          <button
            type="button"
            className="icon-btn -mr-2"
            onClick={onClose}
            aria-label="Close task details"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        {pendingSync ? (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-12 text-warning">
            <Cloud className="h-4 w-4 shrink-0" aria-hidden="true" />
            Saved on this device. It will sync when Morrow reconnects.
          </div>
        ) : null}

        <div className="flex items-start gap-1">
          <button
            type="button"
            className="task-check -ml-2 mt-0.5"
            aria-label={done ? `Completed: ${task.title}` : `Complete: ${task.title}`}
            aria-pressed={done}
            disabled={done || completing}
            aria-busy={completing}
            onClick={() => complete(task)}
          >
            <span
              className={cn(
                "h-5 w-5",
                done && "border-accent bg-accent text-accent-ink",
              )}
            >
              {done ? (
                <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
              ) : null}
            </span>
          </button>
          <div className="min-w-0 flex-1">
            <Heading
              className={cn(
                "break-words",
                variant === "page"
                  ? "serif text-28 md:text-[2rem] md:leading-[2.25rem]"
                  : "serif text-22 leading-tight",
                done && "text-faint line-through",
              )}
            >
              {task.title}
            </Heading>
            <p className="mt-1.5 text-13 text-muted">
              {list ? (
                <span
                  className="inline-flex items-center gap-1.5"
                  data-list-color={listColorSlug(list.color)}
                >
                  <span className="list-dot" aria-hidden="true" />
                  {listDisplayName(list)}
                </span>
              ) : (
                "Inbox"
              )}
              <span aria-hidden="true"> · </span>
              <span className={overdue && !done ? "text-danger" : undefined}>
                {overdue && !done ? "Overdue · " : ""}
                {formatTaskDate(task)}
              </span>
            </p>
          </div>
        </div>

        {editing ? (
          <form
            className="mt-6 space-y-4 rounded-md border border-hairline bg-canvas p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            aria-label="Edit task"
          >
            {editingTask && task.rev !== editingTask.rev ? (
              <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-12 leading-relaxed text-warning">
                This task changed elsewhere while you were editing. Saving will
                ask you to reload or overwrite; nothing is applied silently.
              </p>
            ) : null}
            <div>
              <label htmlFor="task-title" className="field-label">
                Title
              </label>
              <input
                id="task-title"
                ref={titleRef}
                className="input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={1000}
                autoComplete="off"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <label htmlFor="task-date" className="field-label">
                  When
                </label>
                <input
                  id="task-date"
                  ref={dateRef}
                  type={allDay ? "date" : "datetime-local"}
                  className="input"
                  value={dateValue}
                  onChange={(event) => setDateValue(event.target.value)}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 text-12 text-muted">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--accent)]"
                      checked={allDay}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setAllDay(next);
                        if (!dateValue) return;
                        if (next) setDateValue(dateValue.slice(0, 10));
                        else if (!dateValue.includes("T")) {
                          setDateValue(`${dateValue.slice(0, 10)}T09:00`);
                        }
                      }}
                    />
                    All day
                  </label>
                  {dateValue ? (
                    <button
                      type="button"
                      className="btn btn-ghost min-h-11 px-2 text-12"
                      onClick={() => {
                        setDateValue("");
                        setAllDay(false);
                      }}
                    >
                      Clear date
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0">
                <label htmlFor="task-repeat" className="field-label">
                  Repeat
                </label>
                <select
                  id="task-repeat"
                  ref={repeatRef}
                  className="select"
                  value={recurrenceValueState}
                  onChange={(event) => setRecurrenceValueState(event.target.value)}
                >
                  {RECURRENCE_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                  <option value="custom">Custom RRULE…</option>
                </select>
                {recurrenceValueState === "custom" ? (
                  <input
                    className="input mono mt-2 text-12"
                    value={customRrule}
                    onChange={(event) => setCustomRrule(event.target.value)}
                    placeholder="RRULE:FREQ=WEEKLY;INTERVAL=2"
                    aria-label="Custom recurrence rule"
                  />
                ) : null}
                {recurrenceValueState !== "none" && !dateValue ? (
                  <p className="field-help text-warning">
                    Add a date first; recurrence needs a start.
                  </p>
                ) : null}
                {recurrenceValueState !== "none" ? (
                  <div className="mt-3">
                    <label htmlFor="task-repeat-end" className="field-label">
                      Ends
                    </label>
                    <select
                      id="task-repeat-end"
                      className="select"
                      value={repeatEndMode}
                      onChange={(event) =>
                        setRepeatEndMode(
                          event.target.value as "none" | "date" | "count",
                        )
                      }
                    >
                      <option value="none">Never</option>
                      <option value="date">On a date</option>
                      <option value="count">After a number of times</option>
                    </select>
                    {repeatEndMode === "date" ? (
                      <input
                        type="date"
                        className="input mt-2"
                        value={repeatUntilDate}
                        min={dateValue.slice(0, 10)}
                        onChange={(event) => setRepeatUntilDate(event.target.value)}
                        aria-label="Repeat end date"
                      />
                    ) : null}
                    {repeatEndMode === "count" ? (
                      <input
                        type="number"
                        min={1}
                        max={100000}
                        className="input mt-2"
                        value={repeatCount}
                        onChange={(event) => setRepeatCount(event.target.value)}
                        aria-label="Repeat count"
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <label htmlFor="task-list" className="field-label">
                  List
                </label>
                <select
                  id="task-list"
                  className="select"
                  value={listId}
                  onChange={(event) => setListId(event.target.value)}
                >
                  <option value="">Inbox</option>
                  {lists.map((option) => (
                    <option key={option.id} value={option.id}>
                      {listDisplayName(option)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="min-w-0">
                <label htmlFor="task-priority" className="field-label">
                  Priority
                </label>
                <select
                  id="task-priority"
                  className="select"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                >
                  <option value="0">None</option>
                  <option value="1">Low</option>
                  <option value="2">Medium</option>
                  <option value="3">High</option>
                  <option value="4">Urgent</option>
                </select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <label htmlFor="task-reminder" className="field-label">
                  Reminder
                </label>
                <select
                  id="task-reminder"
                  className="select"
                  value={remindOffset}
                  onChange={(event) => setRemindOffset(event.target.value)}
                >
                  <option value="0">At due time</option>
                  <option value="-10">10 min before</option>
                  <option value="-60">1 hour before</option>
                  <option value="-1440">1 day before</option>
                  <option value="custom">Custom…</option>
                </select>
                {remindOffset === "custom" ? (
                  <input
                    className="input mono mt-2 text-12"
                    value={customOffset}
                    onChange={(event) => setCustomOffset(event.target.value)}
                    placeholder="-30 (minutes, negative = before)"
                    aria-label="Custom reminder offset in minutes"
                    inputMode="numeric"
                  />
                ) : null}
                <p className="field-help">
                  Applies to the due time; editing the date re-arms it.
                </p>
              </div>
              {allDay ? (
                <div className="min-w-0">
                  <label htmlFor="task-reminder-time" className="field-label">
                    Reminder time
                  </label>
                  <input
                    id="task-reminder-time"
                    type="time"
                    className="input"
                    value={reminderTime}
                    onChange={(event) => setReminderTime(event.target.value)}
                  />
                  <p className="field-help">Local time on the due date.</p>
                </div>
              ) : null}
            </div>

            <div>
              <label htmlFor="task-notes" className="field-label">
                Notes
              </label>
              <textarea
                id="task-notes"
                className="textarea min-h-24"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={100_000}
              />
            </div>

            {formError ? (
              <p role="alert" className="text-13 text-danger">
                {formError}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setEditing(false);
                  setEditingTask(null);
                  setFormError(null);
                }}
                disabled={updateTask.isPending}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={updateTask.isPending}
                aria-busy={updateTask.isPending}
              >
                {updateTask.isPending ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        ) : (
          <dl className="mt-7 divide-y divide-hairline overflow-hidden rounded-md border border-hairline bg-canvas text-13">
            <div className="flex gap-3 px-3 py-3">
              <dt className="flex w-24 shrink-0 items-center gap-2 text-muted">
                <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                When
              </dt>
              <dd className="min-w-0 text-ink-soft">{formatTaskDate(task)}</dd>
            </div>
            <div className="flex gap-3 px-3 py-3">
              <dt className="flex w-24 shrink-0 items-center gap-2 text-muted">
                <ListIcon className="h-3.5 w-3.5" aria-hidden="true" />
                List
              </dt>
              <dd className="min-w-0 truncate text-ink-soft">
                {list ? listDisplayName(list) : "Inbox"}
              </dd>
            </div>
            <div className="flex gap-3 px-3 py-3">
              <dt className="flex w-24 shrink-0 items-center gap-2 text-muted">
                <Repeat2 className="h-3.5 w-3.5" aria-hidden="true" />
                Repeat
              </dt>
              <dd className="min-w-0 text-ink-soft">
                {recurrence ?? "Doesn’t repeat"}
                {task.recurrenceCount
                  ? ` · ${task.recurrenceCount} times`
                  : task.recurrenceUntilDate
                    ? ` · until ${task.recurrenceUntilDate.slice(0, 10)}`
                    : ""}
              </dd>
            </div>
            <div className="flex gap-3 px-3 py-3">
              <dt className="flex w-24 shrink-0 items-center gap-2 text-muted">
                <Flag className="h-3.5 w-3.5" aria-hidden="true" />
                Priority
              </dt>
              <dd className="min-w-0 text-ink-soft">
                {["None", "Low", "Medium", "High", "Urgent"][
                  Number(task.priority ?? 0)
                ] ?? "None"}
              </dd>
            </div>
            <div className="flex gap-3 px-3 py-3">
              <dt className="flex w-24 shrink-0 items-center gap-2 text-muted">
                <Bell className="h-3.5 w-3.5" aria-hidden="true" />
                Reminder
              </dt>
              <dd className="min-w-0 text-ink-soft">
                {task.remindAt ? (
                  formatTimestamp(task.remindAt)
                ) : snoozed ? (
                  `Snoozed until ${snoozeUntilLabel(task)}`
                ) : task.nextOccurrenceAt ? (
                  `Next ${formatTimestamp(task.nextOccurrenceAt)}`
                ) : (
                  <span className="text-muted">No reminder set</span>
                )}
              </dd>
            </div>
            {task.completedAt ? (
              <div className="flex gap-3 px-3 py-3">
                <dt className="flex w-24 shrink-0 items-center gap-2 text-muted">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  Completed
                </dt>
                <dd className="min-w-0 text-ink-soft">
                  {formatTimestamp(task.completedAt)}
                </dd>
              </div>
            ) : null}
          </dl>
        )}

        <TaskTagsSection task={task} />

        <SubtaskSection task={task} />

        <AttachmentSection task={task} />

        <section className="mt-7" aria-labelledby="task-notes-heading">
          <h3 id="task-notes-heading" className="label-caps mb-2">
            Notes
          </h3>
          {task.notes ? (
            <Markdown>{task.notes}</Markdown>
          ) : (
            <p className="text-13 text-muted">
              No notes. Keep the task light.
            </p>
          )}
        </section>

        <details className="group mt-7 rounded-md border border-hairline bg-canvas" open>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-3 text-13 text-ink-soft [&::-webkit-details-marker]:hidden">
            <span className="flex-1">Reminders &amp; delivery</span>
            <ChevronRight
              className="h-4 w-4 text-faint transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
          </summary>
          <div className="border-t border-hairline">
            <DeliveryLedger task={task} />
          </div>
        </details>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => beginEdit("title")}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Edit task
          </button>
          {task.rrule ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => skip(task)}
              disabled={skipping}
              aria-busy={skipping}
            >
              <SkipForward className="h-4 w-4" aria-hidden="true" />
              Skip occurrence
            </button>
          ) : null}
          {undo.canUndo ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void undo.undo()}
            >
              <Undo2 className="h-4 w-4" aria-hidden="true" />
              Undo last change
            </button>
          ) : null}
        </div>
      </div>

      <div className="safe-bottom flex shrink-0 flex-wrap items-center gap-2 border-t border-hairline bg-surface px-4 py-3">
        <button
          type="button"
          className="btn btn-primary flex-1"
          onClick={() => complete(task)}
          disabled={done || completing}
          aria-busy={completing}
        >
          <Check className="h-4 w-4" aria-hidden="true" />
          {done ? "Completed" : completing ? "Completing…" : "Mark done"}
        </button>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={done || snoozing}
              aria-label="Snooze task"
              aria-busy={snoozing}
            >
              <Clock3 className="h-4 w-4" aria-hidden="true" />
              Snooze
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              sideOffset={6}
              align="end"
              className="z-[60] min-w-52 rounded-md border border-hairline bg-canvas p-1 text-13 shadow-lg"
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
                >
                  <span>{option.label}</span>
                  <span className="mono ml-3 text-12 text-faint">
                    {snoozeLabel(option.until)}
                  </span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="icon-btn border border-hairline-strong"
              aria-label="More task actions"
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              sideOffset={6}
              align="end"
              className="z-[60] min-w-52 rounded-md border border-hairline bg-canvas p-1 text-13 shadow-lg"
            >
              {variant === "inspector" ? (
                <DropdownMenu.Item
                  onSelect={openFullPage}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 outline-none data-[highlighted]:bg-selection"
                >
                  <ArrowLeft
                    className="h-4 w-4 rotate-180 text-muted"
                    aria-hidden="true"
                  />
                  Open full page
                </DropdownMenu.Item>
              ) : null}
              <DropdownMenu.Item
                onSelect={() => beginEdit("title")}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 outline-none data-[highlighted]:bg-selection"
              >
                <Pencil className="h-4 w-4 text-muted" aria-hidden="true" />
                Edit
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => beginEdit("date")}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 outline-none data-[highlighted]:bg-selection"
              >
                <CalendarClock className="h-4 w-4 text-muted" aria-hidden="true" />
                Change date
                <kbd className="kbd ml-auto">D</kbd>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => beginEdit("repeat")}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2.5 outline-none data-[highlighted]:bg-selection"
              >
                <Repeat2 className="h-4 w-4 text-muted" aria-hidden="true" />
                Change repeat
                <kbd className="kbd ml-auto">R</kbd>
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

      <DialogFrame
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${task.title}`}
        description="Soft-delete this task on the server."
      >
        <div className="p-5 md:p-6">
          <h2 className="serif text-22">Delete this task?</h2>
          <p className="mt-2 text-13 leading-relaxed text-muted">
            “{task.title}” will leave every view. It is soft-deleted on the
            server; restore it from Recently deleted within 30 days.
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
                deleteTask.mutate(task, { onSuccess: closeAfterDelete });
              }}
            >
              {deleteTask.isPending ? "Deleting…" : "Delete task"}
            </button>
          </div>
        </div>
      </DialogFrame>
    </div>
  );
}
