import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiErrorMessage } from "@/api";
import { Announcer } from "@/components/Announcer";
import { AssistantPanel } from "@/components/AssistantPanel";
import { BrandMark } from "@/components/BrandMark";
import { CaptureSheet } from "@/components/CaptureSheet";
import { CommandPalette } from "@/components/CommandPalette";
import { ConflictDialog } from "@/components/ConflictDialog";
import { DialogFrame } from "@/components/DialogFrame";
import { MobileTabs, CaptureFab } from "@/components/MobileTabs";
import { OfflineBanner } from "@/components/OfflineBanner";
import { Sidebar } from "@/components/Sidebar";
import { TaskDetail } from "@/components/TaskDetail";
import { TaskListSkeleton } from "@/components/TaskListStates";
import { TopBar } from "@/components/TopBar";
import { ShellActionsProvider, type ShellActions } from "@/components/shell-context";
import { announce } from "@/lib/announce";
import { updateAppBadge } from "@/lib/badge";
import { subscribeConflict, type ConflictReport } from "@/lib/conflict";
import { connectActivityStream } from "@/lib/events";
import { useMediaQuery } from "@/lib/hooks";
import { invalidateTaskQueries } from "@/lib/query";
import {
  useBootstrapQuery,
  useTaskActions,
  useTaskDetail,
} from "@/lib/queries";
import { replayOutbox } from "@/lib/outbox";
import { endSession } from "@/lib/session";
import { focusTaskField } from "@/lib/shortcuts";
import { undoLast } from "@/lib/undo";
import { inMinutes } from "@/lib/schedule";
import { isEditableTarget, isInteractiveTarget } from "@/lib/utils";

export function ShellSkeleton() {
  return (
    <div
      className="flex h-[100dvh] overflow-hidden bg-canvas"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="hidden w-[252px] shrink-0 border-r border-hairline bg-surface p-4 md:block">
        <div className="skeleton h-8 w-32" />
        <div className="mt-8 space-y-2">
          <div className="skeleton h-10 w-full" />
          <div className="skeleton h-10 w-full" />
          <div className="skeleton h-10 w-full" />
        </div>
        <div className="mt-8 skeleton h-3 w-16" />
        <div className="mt-3 space-y-2">
          <div className="skeleton h-9 w-full" />
          <div className="skeleton h-9 w-5/6" />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 items-center border-b border-hairline px-5">
          <div className="skeleton h-9 w-64" />
        </div>
        <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
          <div className="skeleton h-4 w-44" />
          <div className="skeleton mt-4 h-9 w-72" />
          <div className="skeleton mt-3 h-4 w-56" />
          <div className="skeleton mt-8 h-12 w-full" />
          <div className="mt-8 space-y-2">
            <div className="skeleton h-14 w-full" />
            <div className="skeleton h-14 w-full" />
            <div className="skeleton h-14 w-full" />
          </div>
        </div>
        <span className="sr-only">Loading Morrow</span>
      </div>
    </div>
  );
}

function BootstrapFailure({
  error,
  onRetry,
  isRetrying,
}: {
  error: unknown;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  return (
    <main className="safe-top flex min-h-[100dvh] items-center justify-center bg-canvas px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-3">
          <BrandMark className="h-9 w-9" />
          <span className="serif text-22">Morrow</span>
        </div>
        <p className="label-caps">Connection</p>
        <h1 className="serif mt-2 text-28">Can’t reach Morrow.</h1>
        <p className="mt-3 text-15 leading-relaxed text-muted">
          {apiErrorMessage(error)}
        </p>
        <p className="mt-2 text-13 leading-relaxed text-muted">
          If you’re offline, this device will show saved data once it has loaded
          once. Nothing on the server was changed.
        </p>
        <div className="mt-7 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onRetry}
            disabled={isRetrying}
            aria-busy={isRetrying}
          >
            {isRetrying ? "Trying…" : "Try again"}
          </button>
          <Link to="/login" className="btn btn-secondary">
            Sign in again
          </Link>
        </div>
      </div>
    </main>
  );
}

function routeTaskIdFrom(pathname: string): string | null {
  if (!pathname.startsWith("/tasks/")) return null;
  const raw = pathname.slice("/tasks/".length).split("/")[0] ?? "";
  return raw ? decodeURIComponent(raw) : null;
}

export function App() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { data, isPending, isError, error, refetch, isFetching } = useBootstrapQuery();
  const { complete, snooze } = useTaskActions();

  const narrow = useMediaQuery("(max-width: 1279px)");
  const isThreePane = !narrow;
  const [collapsed, setCollapsed] = useState(narrow);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureListId, setCaptureListId] = useState<string | null>(null);
  const [captureSeed, setCaptureSeed] = useState<{ date?: string; title?: string }>({});
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantPrompt, setAssistantPrompt] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [conflict, setConflict] = useState<ConflictReport | null>(null);

  const tasks = data?.tasks ?? [];
  const lists = data?.lists ?? [];

  // Keep the installed-app badge aligned with today's open work. The service
  // worker updates it for push too; the page is the source of truth on launch.
  useEffect(() => {
    if (data) {
      void updateAppBadge(
        data.tasks,
        new Date(),
        data.user?.timezone ?? undefined,
      );
    }
  }, [data]);

  const selectedDetail = useTaskDetail(selectedTaskId);
  const selectedTask =
    selectedDetail.data ??
    tasks.find((task) => task.id === selectedTaskId) ??
    null;

  const routeTaskId = routeTaskIdFrom(pathname);
  const routeDetail = useTaskDetail(routeTaskId);
  const routeTask =
    routeDetail.data ??
    (routeTaskId ? tasks.find((task) => task.id === routeTaskId) : undefined) ??
    null;
  const keyboardTask = routeTaskId ? routeTask : selectedTask;

  const inspectorSheetOpen = Boolean(selectedTask && inspectorOpen && !isThreePane);

  useEffect(() => {
    setCollapsed(narrow);
  }, [narrow]);

  // Clear inspector state when navigating away from a task/list view.
  useEffect(() => {
    // The full task page owns the screen; other routes deliberately close the
    // inspector. This also avoids a duplicate editor on /tasks/:id.
    setSelectedTaskId(null);
    setInspectorOpen(false);
  }, [pathname]);

  // If a selected task disappears (completed elsewhere, deleted), close the
  // inspector once its detail query has settled rather than showing stale UI.
  useEffect(() => {
    if (
      selectedTaskId &&
      data &&
      !selectedTask &&
      !selectedDetail.isPending
    ) {
      setSelectedTaskId(null);
      setInspectorOpen(false);
    }
  }, [data, selectedDetail.isPending, selectedTask, selectedTaskId]);

  // PWA share target / capture shortcut: /today?capture=1 opens the sheet
  // once. Android share sheets pass title/text/url, which become the seed.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sharedTitle = params.get("title") ?? "";
    const sharedText = params.get("text") ?? "";
    const sharedUrl = params.get("url") ?? "";
    const shared = [sharedTitle, sharedText, sharedUrl]
      .filter((value) => value.trim() !== "")
      .join(" ")
      .trim();
    if (params.get("capture") === "1" || shared !== "") {
      setCaptureSeed(shared ? { title: shared.slice(0, 2000) } : {});
      setCaptureOpen(true);
      for (const key of ["capture", "title", "text", "url"]) params.delete(key);
      const query = params.toString();
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
      );
    }
  }, []);

  // SSE (M2 wire, M1 stub): task/list activity refreshes data without a
  // full reload. Coalesce bursts so a scheduler tick cannot cause a refetch storm.
  const activityTimer = useRef<number | null>(null);
  const hasBootstrapData = Boolean(data);
  useEffect(() => {
    if (!hasBootstrapData) return;
    const handle = connectActivityStream({
      onEvent: (event) => {
        const kind = event.entity.kind;
        const relevant =
          kind === "task" ||
          kind === "list" ||
          event.type.startsWith("task.") ||
          event.type.startsWith("list.");
        if (!relevant) return;
        if (activityTimer.current !== null) return;
        activityTimer.current = window.setTimeout(() => {
          activityTimer.current = null;
          void invalidateTaskQueries(queryClient);
        }, 400);
      },
    });
    return () => {
      handle.close();
      if (activityTimer.current !== null) {
        window.clearTimeout(activityTimer.current);
        activityTimer.current = null;
      }
    };
  }, [hasBootstrapData, queryClient]);

  // Replay the outbox BEFORE refreshing bootstrap on reconnect/visibility.
  useEffect(() => {
    let cancelled = false;

    const flush = async () => {
      if (typeof navigator !== "undefined" && !navigator.onLine) return;
      try {
        const result = await replayOutbox();
        if (cancelled) return;
        if (result.stoppedBy === "conflict") {
          announce("Some queued changes need a decision.");
        }
        if (
          result.replayed > 0 ||
          result.stoppedBy === "empty" ||
          result.stoppedBy === "conflict" ||
          result.stoppedBy === "error"
        ) {
          // A conflicted/rejected op was NOT applied. Refresh to the server
          // truth while keeping the queued change visible in the outbox panel.
          await invalidateTaskQueries(queryClient);
        }
      } catch {
        // The outbox banner owns the visible failure state.
      }
    };

    const onOnline = () => void flush();
    const onVisible = () => {
      if (document.visibilityState === "visible") void flush();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [queryClient]);

  useEffect(
    () =>
      subscribeConflict((report) => {
        setConflict(report);
        announce(
          report.title ?? report.message ?? "A change needs your decision.",
        );
      }),
    [],
  );

  // A 401 from any API call ends the local session for safety.
  useEffect(() => {
    let handled = false;
    const onExpired = () => {
      if (handled) return;
      handled = true;
      void (async () => {
        await endSession({ expired: true });
        void navigate({ to: "/session-expired", replace: true });
      })();
    };
    window.addEventListener("morrow:session-expired", onExpired);
    return () => window.removeEventListener("morrow:session-expired", onExpired);
  }, [navigate]);

  // Keyboard path: N/C capture, D date, R repeat, S snooze, Space done, Cmd+Z undo.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const command = event.metaKey || event.ctrlKey;

      if (command && key === "k") {
        const dialogOpen = document.querySelector(
          '[role="dialog"][data-state="open"]',
        );
        // Don't stack the palette over capture/conflict/outbox; Cmd+K still
        // closes the palette itself.
        if (dialogOpen && !paletteOpen) return;
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }

      if (document.querySelector('[role="dialog"][data-state="open"]')) return;

      if (command && key === "z" && !isEditableTarget(event.target)) {
        event.preventDefault();
        void undoLast();
        return;
      }

      if (command || event.altKey || event.repeat) return;
      if (isEditableTarget(event.target)) return;
      if (paletteOpen || captureOpen || assistantOpen || inspectorSheetOpen) return;

      if (key === "n" || key === "c") {
        event.preventDefault();
        setCaptureListId(null);
        setCaptureOpen(true);
        return;
      }

      if (key === "escape") {
        if (selectedTaskId) {
          setSelectedTaskId(null);
          setInspectorOpen(false);
        }
        return;
      }

      if (!keyboardTask) {
        if (key === " " || key === "d" || key === "r" || key === "s") {
          toast("Select a task first", {
            description: "Click a task row to open its details.",
          });
        }
        return;
      }

      if (key === " ") {
        if (isInteractiveTarget(event.target)) return;
        event.preventDefault();
        complete(keyboardTask);
        return;
      }

      if (key === "d") {
        event.preventDefault();
        focusTaskField(keyboardTask.id, "date");
        return;
      }

      if (key === "r") {
        event.preventDefault();
        focusTaskField(keyboardTask.id, "repeat");
        return;
      }

      if (key === "s") {
        event.preventDefault();
        snooze(keyboardTask, inMinutes(60));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    assistantOpen,
    captureOpen,
    complete,
    inspectorSheetOpen,
    keyboardTask,
    paletteOpen,
    selectedTaskId,
    snooze,
  ]);

  const closeInspector = () => {
    setInspectorOpen(false);
    setSelectedTaskId(null);
  };

  const actions: ShellActions = {
    openCapture: (listId, seed) => {
      setCaptureListId(listId ?? null);
      setCaptureSeed(seed ?? {});
      setCaptureOpen(true);
    },
    openAssistant: (prompt) => {
      setAssistantPrompt(prompt ?? null);
      setAssistantOpen(true);
    },
    assistantPrompt,
    consumeAssistantPrompt: () => setAssistantPrompt(null),
    openPalette: () => setPaletteOpen(true),
    selectTask: (taskId) => {
      setSelectedTaskId(taskId);
      setInspectorOpen(true);
    },
    closeInspector,
    selectedTaskId,
  };

  if (isPending && !data) return <ShellSkeleton />;

  if (isError && !data) {
    return (
      <BootstrapFailure
        error={error}
        onRetry={() => void refetch()}
        isRetrying={isFetching}
      />
    );
  }

  return (
    <ShellActionsProvider value={actions}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <Announcer />

      <div className="safe-x flex h-[100dvh] overflow-hidden bg-canvas">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <OfflineBanner />

          <div className="relative flex min-h-0 flex-1">
            <main
              id="main"
              tabIndex={-1}
              className="min-w-0 flex-1 overflow-y-auto focus:outline-none"
            >
              <Outlet />
            </main>

            {selectedTask || selectedTaskId ? (
              <aside
                className="hidden w-[372px] shrink-0 flex-col border-l border-hairline bg-surface xl:flex"
                aria-label="Task details"
              >
                {selectedTask ? (
                  <TaskDetail
                    task={selectedTask}
                    lists={lists}
                    onClose={closeInspector}
                  />
                ) : (
                  <div className="px-4 py-5">
                    <TaskListSkeleton rows={3} />
                  </div>
                )}
              </aside>
            ) : null}

            <CaptureFab />
          </div>

          <MobileTabs />
        </div>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />

      <CaptureSheet
        open={captureOpen}
        onOpenChange={setCaptureOpen}
        initialListId={captureListId}
        initialDate={captureSeed.date}
        initialTitle={captureSeed.title}
      />

      <ConflictDialog report={conflict} onClose={() => setConflict(null)} />

      <DialogFrame
        open={Boolean(selectedTask && inspectorOpen && !isThreePane)}
        onOpenChange={(open) => {
          if (!open) closeInspector();
        }}
        title={selectedTask?.title ?? "Task details"}
        kind="full"
      >
        {selectedTask ? (
          <div className="safe-top h-[100dvh] bg-surface">
            <TaskDetail
              task={selectedTask}
              lists={lists}
              onClose={closeInspector}
            />
          </div>
        ) : selectedTaskId ? (
          <div className="safe-top h-[100dvh] bg-surface px-4 py-5">
            <TaskListSkeleton rows={3} />
          </div>
        ) : null}
      </DialogFrame>

      <DialogFrame
        open={assistantOpen}
        onOpenChange={setAssistantOpen}
        title="Assistant"
        description="Assistant. Optional; proposes changes for approval."
        kind="sheet"
      >
        <div className="flex max-h-[inherit] min-h-0 flex-col bg-surface">
          <AssistantPanel onClose={() => setAssistantOpen(false)} />
        </div>
      </DialogFrame>
    </ShellActionsProvider>
  );
}
