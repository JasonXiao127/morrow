import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import {
  CalendarClock,
  CalendarDays,
  Check,
  Clock3,
  Inbox,
  List,
  Moon,
  Plus,
  Repeat2,
  Search,
  Settings,
  SkipForward,
  Sparkles,
  Sun,
  Trash2,
  Undo2,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  formatTaskDate,
  isOpenTask,
  listColorSlug,
  listDisplayName,
  taskList,
} from "@/lib/format";
import {
  useAppData,
  useSearchTasks,
  useTaskActions,
  useTaskDetail,
} from "@/lib/queries";
import { focusTaskField } from "@/lib/shortcuts";
import { useTheme } from "@/lib/theme";
import { useUndoState } from "@/lib/undo";
import { inMinutes } from "@/lib/schedule";
import { cn } from "@/lib/utils";
import { DialogFrame } from "./DialogFrame";
import { useShell } from "./shell-context";

function PaletteItem({
  icon,
  children,
  value,
  onSelect,
  disabled = false,
  keywords,
}: {
  icon: ReactNode;
  children: ReactNode;
  value: string;
  onSelect: () => void;
  disabled?: boolean;
  keywords?: string;
}) {
  return (
    <Command.Item
      value={value}
      keywords={keywords ? [keywords] : undefined}
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-13 text-ink",
        "data-[selected=true]:bg-selection data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50",
      )}
    >
      <span className="flex h-4 w-4 items-center justify-center text-muted" aria-hidden="true">
        {icon}
      </span>
      {children}
    </Command.Item>
  );
}

/**
 * Cmd+K command + search (plan §9). Actions mirror the keyboard map:
 * N capture, D date, R repeat, S snooze, Space done, Cmd+Z undo.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { lists, tasks, user } = useAppData();
  const isOwner = user?.role === "owner";
  const { toggle } = useTheme();
  const { complete, snooze, skip } = useTaskActions();
  const undo = useUndoState();
  const { selectedTaskId, openCapture, openAssistant } = useShell();
  const selectedQuery = useTaskDetail(selectedTaskId);
  const selectedTask =
    selectedQuery.data ??
    tasks.find((task) => task.id === selectedTaskId) ??
    null;

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const searchQuery = useSearchTasks(debounced);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setDebounced("");
    }
  }, [open]);

  const localMatches = useMemo(() => {
    const needle = debounced.toLowerCase();
    if (!needle) return [];
    return tasks
      .filter(
        (task) =>
          isOpenTask(task) &&
          (task.title.toLowerCase().includes(needle) ||
            (task.notes ?? "").toLowerCase().includes(needle) ||
            (taskList(task, lists)?.name ?? "").toLowerCase().includes(needle)),
      )
      .slice(0, 10);
  }, [debounced, lists, tasks]);

  const resultTasks = useMemo(() => {
    const seen = new Set<string>();
    const out = [];
    for (const task of [
      ...(searchQuery.data?.tasks ?? []),
      ...localMatches,
    ]) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      out.push(task);
    }
    return out.slice(0, 30);
  }, [localMatches, searchQuery.data]);

  const recentTasks = useMemo(
    () => tasks.filter(isOpenTask).slice(0, 8),
    [tasks],
  );

  const go = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <DialogFrame
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search tasks or run a command."
      className="overflow-hidden p-0"
    >
      <Command
        label="Command palette"
        className="flex max-h-[min(70dvh,560px)] flex-col"
      >
        <div className="flex items-center gap-2 border-b border-hairline px-3 input-shell rounded-t-md">
          <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          <Command.Input
            autoFocus
            value={search}
            onValueChange={setSearch}
            placeholder="Search tasks or type a command…"
            className="h-12 w-full bg-transparent text-15 text-ink outline-none placeholder:text-faint"
            aria-label="Search tasks or commands"
          />
          <kbd className="kbd hidden sm:inline-flex">esc</kbd>
        </div>
        <Command.List className="min-h-0 flex-1 overflow-y-auto p-2">
          <Command.Empty className="px-3 py-8 text-center">
            <p className="text-13 font-medium text-ink">No matches.</p>
            <p className="mt-1 text-13 text-muted">
              Try a different word, or add it as something new.
            </p>
            <button
              type="button"
              className="btn btn-secondary mt-4"
              onClick={() => go(() => window.setTimeout(() => openCapture(), 50))}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add something
            </button>
          </Command.Empty>

          <Command.Group heading="Go to">
            <PaletteItem
              icon={<Sun className="h-4 w-4" />}
              value="go today"
              onSelect={() => go(() => void navigate({ to: "/today" }))}
            >
              Today
            </PaletteItem>
            <PaletteItem
              icon={<CalendarDays className="h-4 w-4" />}
              value="go upcoming"
              onSelect={() => go(() => void navigate({ to: "/upcoming" }))}
            >
              Upcoming
            </PaletteItem>
            <PaletteItem
              icon={<Inbox className="h-4 w-4" />}
              value="go inbox"
              onSelect={() => go(() => void navigate({ to: "/inbox" }))}
            >
              Inbox
            </PaletteItem>
            <PaletteItem
              icon={<List className="h-4 w-4" />}
              value="go lists"
              onSelect={() => go(() => void navigate({ to: "/lists" }))}
            >
              All lists
            </PaletteItem>
            {isOwner ? (
              <PaletteItem
                icon={<Sparkles className="h-4 w-4" />}
                value="go assistant"
                onSelect={() => go(() => void navigate({ to: "/assistant" }))}
              >
                Assistant
              </PaletteItem>
            ) : null}
            <PaletteItem
              icon={<Settings className="h-4 w-4" />}
              value="go settings"
              onSelect={() => go(() => void navigate({ to: "/settings" }))}
            >
              Settings
            </PaletteItem>
            <PaletteItem
              icon={<Trash2 className="h-4 w-4" />}
              value="go recently deleted trash"
              onSelect={() => go(() => void navigate({ to: "/trash" }))}
            >
              Recently deleted
            </PaletteItem>
          </Command.Group>

          <Command.Group heading="Actions">
            <PaletteItem
              icon={<Plus className="h-4 w-4" />}
              value="new task capture add"
              onSelect={() => go(() => window.setTimeout(() => openCapture(), 50))}
            >
              Add a task
              <kbd className="kbd ml-auto">N</kbd>
            </PaletteItem>
            {isOwner ? (
              <>
                <PaletteItem
                  icon={<Sun className="h-4 w-4" />}
                  value="ask assistant plan my day"
                  onSelect={() =>
                    go(() =>
                      openAssistant(
                        "Plan my day. Look at overdue, today, and unscheduled tasks. Propose a small plan; do not change anything yet.",
                      ),
                    )
                  }
                >
                  Ask · Plan my day
                </PaletteItem>
                <PaletteItem
                  icon={<Sparkles className="h-4 w-4" />}
                  value="ask assistant overdue what is late"
                  onSelect={() =>
                    go(() =>
                      openAssistant(
                        "What is overdue? Summarize the tasks and suggest the smallest useful next step.",
                      ),
                    )
                  }
                >
                  Ask · What’s overdue?
                </PaletteItem>
                <PaletteItem
                  icon={<Inbox className="h-4 w-4" />}
                  value="ask assistant triage inbox"
                  onSelect={() =>
                    go(() =>
                      openAssistant(
                        "Triage my inbox. Suggest a few concrete changes as a proposal; nothing should change until I approve.",
                      ),
                    )
                  }
                >
                  Ask · Triage my inbox
                </PaletteItem>
              </>
            ) : null}
            <PaletteItem
              icon={<Check className="h-4 w-4" />}
              value="complete selected task done"
              disabled={!selectedTask}
              onSelect={() =>
                go(() => {
                  if (selectedTask) complete(selectedTask);
                })
              }
            >
              Complete selected task
              <kbd className="kbd ml-auto">Space</kbd>
            </PaletteItem>
            <PaletteItem
              icon={<Clock3 className="h-4 w-4" />}
              value="snooze selected task hour"
              disabled={!selectedTask}
              onSelect={() =>
                go(() => {
                  if (selectedTask) snooze(selectedTask, inMinutes(60));
                })
              }
            >
              Snooze selected 1 hour
              <kbd className="kbd ml-auto">S</kbd>
            </PaletteItem>
            <PaletteItem
              icon={<CalendarClock className="h-4 w-4" />}
              value="change selected date when"
              disabled={!selectedTask}
              onSelect={() =>
                go(() => {
                  if (selectedTask) focusTaskField(selectedTask.id, "date");
                })
              }
            >
              Change selected date
              <kbd className="kbd ml-auto">D</kbd>
            </PaletteItem>
            <PaletteItem
              icon={<Repeat2 className="h-4 w-4" />}
              value="change selected repeat recurrence"
              disabled={!selectedTask}
              onSelect={() =>
                go(() => {
                  if (selectedTask) focusTaskField(selectedTask.id, "repeat");
                })
              }
            >
              Change selected repeat
              <kbd className="kbd ml-auto">R</kbd>
            </PaletteItem>
            <PaletteItem
              icon={<SkipForward className="h-4 w-4" />}
              value="skip selected occurrence"
              disabled={!selectedTask?.rrule}
              onSelect={() =>
                go(() => {
                  if (selectedTask) skip(selectedTask);
                })
              }
            >
              Skip this occurrence
            </PaletteItem>
            <PaletteItem
              icon={<Undo2 className="h-4 w-4" />}
              value="undo last action"
              disabled={!undo.canUndo}
              keywords={undo.label ?? undefined}
              onSelect={() => go(() => void undo.undo())}
            >
              Undo {undo.label ? `“${undo.label}”` : "last action"}
              <kbd className="kbd ml-auto">⌘Z</kbd>
            </PaletteItem>
            <PaletteItem
              icon={<Moon className="h-4 w-4" />}
              value="toggle theme dark light"
              onSelect={() => go(toggle)}
            >
              Toggle theme
            </PaletteItem>
          </Command.Group>

          {debounced.length >= 2 ? (
            <Command.Group heading="Search results">
              {searchQuery.isFetching && resultTasks.length === 0 ? (
                <p className="px-2.5 py-3 text-13 text-faint">Searching…</p>
              ) : null}
              {!searchQuery.isFetching &&
              resultTasks.length === 0 &&
              !searchQuery.isError ? (
                <p className="px-2.5 py-3 text-13 text-faint">
                  No matches. Try a different word, or add it as something new.
                </p>
              ) : null}
              {searchQuery.isError ? (
                <p className="px-2.5 py-3 text-13 text-danger">
                  Search is unavailable right now. Your saved tasks are shown
                  below.
                </p>
              ) : null}
              {resultTasks.map((task) => {
                const list = taskList(task, lists);
                return (
                  <PaletteItem
                    key={task.id}
                    icon={<Check className="h-4 w-4" />}
                    value={`task ${task.id} ${task.title}`}
                    keywords={`${task.title} ${task.notes ?? ""} ${list?.name ?? ""}`}
                    onSelect={() =>
                      go(() =>
                        void navigate({
                          to: "/tasks/$taskId",
                          params: { taskId: task.id },
                        }),
                      )
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{task.title}</span>
                      <span className="block truncate text-12 text-faint">
                        {formatTaskDate(task)}
                      </span>
                    </span>
                    {list ? (
                      <span
                        className="flex items-center gap-1.5 text-12 text-faint"
                        data-list-color={listColorSlug(list.color)}
                      >
                        <span className="list-dot" aria-hidden="true" />
                        <span className="max-w-28 truncate">
                          {listDisplayName(list)}
                        </span>
                      </span>
                    ) : null}
                  </PaletteItem>
                );
              })}
            </Command.Group>
          ) : recentTasks.length > 0 ? (
            <Command.Group heading="Open tasks">
              {recentTasks.map((task) => {
                const list = taskList(task, lists);
                return (
                  <PaletteItem
                    key={task.id}
                    icon={<Check className="h-4 w-4" />}
                    value={`task ${task.id} ${task.title}`}
                    keywords={`${task.title} ${task.notes ?? ""} ${list?.name ?? ""}`}
                    onSelect={() =>
                      go(() =>
                        void navigate({
                          to: "/tasks/$taskId",
                          params: { taskId: task.id },
                        }),
                      )
                    }
                  >
                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                    {list ? (
                      <span
                        className="flex items-center gap-1.5 text-12 text-faint"
                        data-list-color={listColorSlug(list.color)}
                      >
                        <span className="list-dot" aria-hidden="true" />
                        <span className="max-w-28 truncate">
                          {listDisplayName(list)}
                        </span>
                      </span>
                    ) : null}
                  </PaletteItem>
                );
              })}
            </Command.Group>
          ) : null}
        </Command.List>
        <div className="flex items-center gap-4 border-t border-hairline px-3 py-2 text-12 text-faint">
          <span className="flex items-center gap-1">
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> to move
          </span>
          <span className="flex items-center gap-1">
            <kbd className="kbd">↵</kbd> to open
          </span>
          <span className="ml-auto hidden sm:inline">Morrow · command</span>
        </div>
      </Command>
    </DialogFrame>
  );
}
