import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  CalendarClock,
  Check,
  List as ListIcon,
  Repeat2,
  Sparkles,
  X,
} from "lucide-react";
import {
  apiErrorMessage,
  captureApi,
  isMissingRoute,
  type ParsedCapture,
} from "@/api";
import {
  formatShortDate,
  formatTime,
  formatTimestamp,
  listDisplayName,
  parseDateKey,
} from "@/lib/format";
import { useAppData, useCreateTask } from "@/lib/queries";
import {
  captureScheduleFromParsed,
  recurrenceLabelForValue,
  RECURRENCE_OPTIONS,
  scheduleFields,
  wallDateTimeFromLocal,
} from "@/lib/schedule";
import { uuidv7 } from "@/lib/utils";
import { useOnline } from "@/lib/hooks";

import { DialogFrame } from "./DialogFrame";

/**
 * The deterministic parser can leave a dangling connector after removing a
 * date phrase ("Milk at", "Dinner on"). Tidy only trailing connector words so
 * the stored title reads like a task, not a fragment.
 */
function tidyParsedTitle(value: string): string {
  let next = value.trim();
  for (let i = 0; i < 3; i += 1) {
    const cleaned = next
      .replace(/[\s,;:.\-]+$/g, "")
      .replace(/\s+(?:at|on|by|for|from|in|to|the|a|an)$/i, "")
      .trim();
    if (cleaned === next) break;
    next = cleaned;
  }
  return next;
}

function parsedDateLabel(parsed: ParsedCapture | null): string | null {
  if (!parsed) return null;
  if (parsed.dueAt) {
    const date = new Date(parsed.dueAt);
    if (!Number.isNaN(date.getTime())) {
      return `${formatShortDate(date)} · ${formatTime(date)}`;
    }
  }
  if (parsed.dueDate) {
    const date = parseDateKey(parsed.dueDate.slice(0, 10));
    return date ? `All day · ${formatShortDate(date)}` : parsed.dueDate;
  }
  return null;
}

/**
 * Quick capture (plan §9).
 *
 * Types a sentence → debounced POST /api/capture/parse → preview chips for
 * title/date/repeat → POST /api/tasks. The preview is editable, and if the
 * parser route is not deployed yet the manual fields still create the task.
 */
export function CaptureSheet({
  open,
  onOpenChange,
  initialListId,
  initialDate,
  initialTitle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialListId?: string | null;
  initialDate?: string;
  initialTitle?: string;
}) {
  const { lists } = useAppData();
  const createTask = useCreateTask();
  const online = useOnline();

  const [title, setTitle] = useState("");
  const [listId, setListId] = useState("");
  const [dateValue, setDateValue] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [recurrence, setRecurrence] = useState("none");
  const [customRrule, setCustomRrule] = useState("");
  const [parsed, setParsed] = useState<ParsedCapture | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parserAvailable, setParserAvailable] = useState(true);
  const [ignoreParsedTitle, setIgnoreParsedTitle] = useState(false);
  const [manualSchedule, setManualSchedule] = useState(false);
  const [manualList, setManualList] = useState(Boolean(initialListId));
  const [error, setError] = useState<string | null>(null);

  const dateRef = useRef<HTMLInputElement>(null);
  const repeatRef = useRef<HTMLSelectElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(initialTitle ?? "");
    setListId(initialListId ?? "");
    setDateValue(initialDate ?? "");
    setAllDay(Boolean(initialDate));
    setRecurrence("none");
    setCustomRrule("");
    setParsed(null);
    setParsing(false);
    setParserAvailable(true);
    setIgnoreParsedTitle(false);
    setManualSchedule(Boolean(initialDate));
    setManualList(Boolean(initialListId));
    setError(null);
  }, [initialDate, initialListId, initialTitle, open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = title.trim();
    if (trimmed.length < 2 || !online) {
      setParsed(null);
      setParsing(false);
      if (!manualSchedule) {
        setAllDay(false);
        setDateValue("");
        setRecurrence("none");
        setCustomRrule("");
      }
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setParsing(true);
      void (async () => {
        try {
          const result = await captureApi.parse(
            trimmed,
            Intl.DateTimeFormat().resolvedOptions().timeZone,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          setParsed(result);
          setParserAvailable(true);
          if (!manualSchedule) {
            const schedule = captureScheduleFromParsed(result);
            setAllDay(schedule.allDay);
            setDateValue(schedule.allDay ? schedule.dateLocal : schedule.dateTimeLocal);
            setRecurrence(schedule.recurrence);
            setCustomRrule(schedule.customRrule);
          }
          if (!manualList && !initialListId) {
            setListId(result.listId ?? "");
          }
        } catch (parseError) {
          if (controller.signal.aborted) return;
          if (isMissingRoute(parseError)) {
            setParserAvailable(false);
          }
          setParsed(null);
          if (!manualSchedule) {
            // Never leave a stale suggestion from the previous text in place.
            setAllDay(false);
            setDateValue("");
            setRecurrence("none");
            setCustomRrule("");
          }
        } finally {
          if (!controller.signal.aborted) setParsing(false);
        }
      })();
    }, 450);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [initialListId, manualList, manualSchedule, online, open, title]);

  const effectiveRecurrence = recurrence;
  const dateLabel = parsed && !manualSchedule
    ? parsedDateLabel(parsed)
    : dateValue
      ? allDay
        ? parseDateKey(dateValue.slice(0, 10))
          ? `All day · ${formatShortDate(parseDateKey(dateValue.slice(0, 10))!)}`
          : dateValue
        : `${formatShortDate(new Date(dateValue))} · ${formatTime(new Date(dateValue))}`
      : null;
  const savedTitle = useMemo(() => {
    if (ignoreParsedTitle) return title.trim();
    const parsedTitle = parsed?.title ? tidyParsedTitle(parsed.title) : "";
    return parsedTitle || title.trim();
  }, [ignoreParsedTitle, parsed?.title, title]);

  const markScheduleManual = () => {
    setManualSchedule(true);
  };

  const applySuggestion = () => {
    if (!parsed) return;
    const schedule = captureScheduleFromParsed(parsed);
    setManualSchedule(false);
    setAllDay(schedule.allDay);
    setDateValue(schedule.allDay ? schedule.dateLocal : schedule.dateTimeLocal);
    setRecurrence(schedule.recurrence);
    setCustomRrule(schedule.customRrule);
    if (!manualList) setListId(parsed.listId ?? "");
  };

  const submit = async () => {
    const typed = title.trim();
    if (!typed) {
      setError("Give the reminder a title.");
      textRef.current?.focus();
      return;
    }
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const useParsedSchedule = Boolean(parsed) && !manualSchedule;
    const schedule = useParsedSchedule && parsed
      ? {
          dueAt: parsed.dueAt ?? null,
          dueDate: parsed.dueDate ? parsed.dueDate.slice(0, 10) : null,
          allDay: Boolean(parsed.allDay || (parsed.dueDate && !parsed.dueAt)),
          timezone: parsed.timezone ?? timezone,
          rrule: parsed.rrule ?? null,
          dtstartLocal:
            parsed.dtstartLocal ??
            (parsed.dueAt
              ? wallDateTimeFromLocal(
                  new Date(parsed.dueAt).toISOString().slice(0, 16),
                )
              : parsed.dueDate?.slice(0, 10) ?? null),
        }
      : scheduleFields({
          dateTimeLocal: allDay ? "" : dateValue,
          dateLocal: allDay ? dateValue.slice(0, 10) : "",
          allDay,
          rrule: effectiveRecurrence,
          customRrule,
          timezone,
        });

    const input = {
      id: uuidv7(),
      title: savedTitle || typed,
      listId: listId || parsed?.listId || null,
      timezone,
      remindAt: useParsedSchedule ? parsed?.remindAt ?? null : null,
      reminderTimeLocal: useParsedSchedule
        ? parsed?.reminderTimeLocal ?? null
        : null,
      remindOffsetMinutes: useParsedSchedule
        ? parsed?.remindOffsetMinutes ?? null
        : null,
      ...schedule,
    };

    setError(null);
    try {
      await createTask.mutateAsync(input);
      onOpenChange(false);
    } catch (submitError) {
      setError(apiErrorMessage(submitError));
    }
  };

  const recurrenceText = recurrenceLabelForValue(
    effectiveRecurrence,
    parsed?.rrule,
  );
  const reminderLabel = parsed?.remindAt
    ? formatTimestamp(parsed.remindAt)
    : null;

  return (
    <DialogFrame
      open={open}
      onOpenChange={onOpenChange}
      title="Capture a task"
      description="Type a sentence; Morrow reads the date and repeat before saving."
      kind="sheet"
    >
      <form
        className="flex max-h-[inherit] flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5 md:px-6 md:pt-6">
          <div>
            <h2 className="serif text-22">Capture it, sort it later.</h2>
            <p className="mt-1 text-13 text-muted">
              A title is enough. Dates are optional.
            </p>
          </div>
          <button
            type="button"
            className="icon-btn -mr-2 -mt-2"
            aria-label="Close capture"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 md:px-6">
          <label htmlFor="capture-title" className="field-label">
            Task
          </label>
          <textarea
            id="capture-title"
            ref={textRef}
            className="textarea min-h-24 text-15"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Milk, tomorrow at 9 — or just “call the dentist”"
            autoFocus
            maxLength={500}
            aria-describedby="capture-title-help"
          />
          <p id="capture-title-help" className="field-help">
            {!online
              ? "Offline: capture saves on this device and syncs when you reconnect."
              : parsing
                ? "Reading the date and repeat…"
                : parserAvailable
                  ? "Dates and repeats are read from the sentence; everything stays editable."
                  : "The date parser isn’t deployed yet. Use the fields below and the task still saves."}
          </p>

          <div
            className="mt-3 flex min-h-11 flex-wrap items-center gap-1.5"
            role="status"
            aria-live="polite"
          >
            {parsed && savedTitle && savedTitle !== title.trim() ? (
              <span className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-accent/30 bg-accent-soft px-3 text-12 text-accent">
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                Saves as “{savedTitle}”
                <button
                  type="button"
                  className="inline-flex min-h-11 items-center underline underline-offset-2"
                  onClick={() => setIgnoreParsedTitle(true)}
                >
                  keep mine
                </button>
              </span>
            ) : null}
            {dateLabel ? (
              <button
                type="button"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 text-12 text-ink-soft hover:border-hairline-strong"
                onClick={() => dateRef.current?.focus()}
              >
                <CalendarClock className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                {dateLabel}
              </button>
            ) : null}
            {effectiveRecurrence !== "none" ? (
              <button
                type="button"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 text-12 text-ink-soft hover:border-hairline-strong"
                onClick={() => repeatRef.current?.focus()}
              >
                <Repeat2 className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                {recurrenceText}
              </button>
            ) : null}
            {reminderLabel ? (
              <span className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 text-12 text-ink-soft">
                <Bell className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                {reminderLabel}
              </span>
            ) : null}
            {manualSchedule && parsed ? (
              <button
                type="button"
                className="btn btn-ghost min-h-11 px-2 text-12"
                onClick={applySuggestion}
              >
                Use suggestion
              </button>
            ) : null}
            {parsing ? (
              <span className="inline-flex items-center gap-1.5 text-12 text-faint">
                <span className="skeleton h-3 w-24" /> parsing
              </span>
            ) : null}
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor="capture-list" className="field-label">
                List
              </label>
              <select
                id="capture-list"
                className="select"
                value={listId}
                onChange={(event) => {
                  setListId(event.target.value);
                  setManualList(true);
                }}
              >
                <option value="">Inbox</option>
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {listDisplayName(list)}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <label
                htmlFor="capture-when"
                className="field-label flex items-center gap-1.5"
              >
                <CalendarClock className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                When
              </label>
              <input
                id="capture-when"
                ref={dateRef}
                type={allDay ? "date" : "datetime-local"}
                className="input"
                value={allDay ? dateValue.slice(0, 10) : dateValue}
                onChange={(event) => {
                  setDateValue(event.target.value);
                  markScheduleManual();
                }}
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
                      markScheduleManual();
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
                      markScheduleManual();
                    }}
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="mt-4">
            <label htmlFor="capture-repeat" className="field-label">
              Repeat
            </label>
            <select
              id="capture-repeat"
              ref={repeatRef}
              className="select"
              value={recurrence}
              onChange={(event) => {
                setRecurrence(event.target.value);
                markScheduleManual();
              }}
            >
              {RECURRENCE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
              <option value="custom">Custom RRULE…</option>
            </select>
            {recurrence === "custom" ? (
              <input
                className="input mono mt-2 text-12"
                value={customRrule}
                onChange={(event) => {
                  setCustomRrule(event.target.value);
                  markScheduleManual();
                }}
                placeholder="RRULE:FREQ=WEEKLY;INTERVAL=2"
                aria-label="Custom recurrence rule"
              />
            ) : null}
          </div>

          {parsed?.listId &&
          !manualList &&
          !initialListId &&
          parsed.listId === listId ? (
            <p className="mt-3 inline-flex items-center gap-1.5 text-12 text-muted">
              <ListIcon className="h-3.5 w-3.5" aria-hidden="true" />
              Matched to {lists.find((list) => list.id === parsed.listId)?.name ?? "a list"}
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="mt-4 text-13 text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <div className="safe-bottom flex items-center justify-between gap-3 border-t border-hairline px-5 pb-4 pt-3 md:px-6">
          <span className="hidden text-12 text-faint sm:inline">
            <kbd className="kbd">⌘</kbd> <kbd className="kbd">↵</kbd> to capture
          </span>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={createTask.isPending}
              aria-busy={createTask.isPending}
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              {createTask.isPending ? "Capturing…" : "Capture"}
            </button>
          </div>
        </div>
      </form>
    </DialogFrame>
  );
}
