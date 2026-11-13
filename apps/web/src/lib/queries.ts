import { useCallback, useMemo } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ApiError,
  api,
  apiErrorMessage,
  isApiError,
  isConcurrencyError,
  isMissingRoute,
  listApi,
  taskApi,
  type BootstrapData,
  type CreateListInput,
  type CreateTaskInput,
  type Task,
  type TaskList,
  type TaskPage,
  type UpdateListInput,
  type UpdateTaskInput,
} from "@/api";
import { announce } from "./announce";
import { reportConflict } from "./conflict";
import { enqueueOutbox } from "./outbox";
import { bootstrapQueryOptions, invalidateTaskQueries, queryKeys, type TaskListKey } from "./query";
import { isOpenTask, sortTasks, taskOccurrenceKey } from "./format";
import {
  getCachedTask,
  mapTaskInCaches,
  removeTaskFromCaches,
  restoreTaskCaches,
  snapshotTaskCaches,
  upsertTaskInCaches,
} from "./task-cache";
import { pushUndo, undoLast } from "./undo";

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export function useBootstrapQuery() {
  return useQuery(bootstrapQueryOptions);
}

export function useAppData() {
  const query = useBootstrapQuery();
  return {
    query,
    bootstrap: query.data,
    lists: query.data?.lists ?? [],
    tasks: query.data?.tasks ?? [],
    tags: query.data?.tags ?? [],
    taskTags: query.data?.taskTags ?? [],
    settings: query.data?.settings ?? {},
    user: query.data?.user ?? null,
  };
}

export interface TaskViewParams extends TaskListKey {
  limit?: number;
}

export function useTaskView(params: TaskViewParams) {
  const queryClient = useQueryClient();
  return useInfiniteQuery({
    queryKey: queryKeys.taskList(params),
    queryFn: async ({ pageParam, signal }) => {
      try {
        return await taskApi.list({
          view: params.view,
          listId: params.listId,
          tagId: params.tagId,
          includeDone: params.includeDone,
          limit: params.limit ?? 50,
          cursor: pageParam,
          signal,
        });
      } catch (error) {
        // M1 server routes are a parallel track. Until GET /api/tasks exists
        // (or while the connection is down), derive this view from the real
        // bootstrap snapshot instead of showing an empty mock.
        if (!shouldUseBootstrapFallback(error)) throw error;
        const bootstrap = await bootstrapSnapshot(queryClient);
        return bootstrapTaskPage(bootstrap, params);
      }
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.nextCursor : null,
    staleTime: 15_000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status < 500) return false;
      return failureCount < 1;
    },
  });
}

export interface TaskListData {
  tasks: Task[];
  pages: TaskPage[];
  query: ReturnType<typeof useTaskView>;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  refetch: () => void;
  usingBootstrapFallback: boolean;
}

export function useTaskListData(params: TaskViewParams): TaskListData {
  const query = useTaskView(params);
  const tasks = useMemo(() => {
    const seen = new Set<string>();
    const out: Task[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const task of page.tasks) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        out.push(task);
      }
    }
    return out;
  }, [query.data]);

  return {
    tasks,
    pages: query.data?.pages ?? [],
    query,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: Boolean(query.hasNextPage),
    fetchNextPage: () => void query.fetchNextPage(),
    refetch: () => void query.refetch(),
    usingBootstrapFallback: Boolean(
      query.data?.pages.some((page) => page.source === "bootstrap"),
    ),
  };
}

function shouldUseBootstrapFallback(error: unknown): boolean {
  if (isMissingRoute(error)) return true;
  // A fetch TypeError means the request never reached the server. A cached
  // bootstrap snapshot is the honest offline read (plan §7).
  return error instanceof TypeError;
}

/**
 * Prefer the already-restored bootstrap cache while offline; only fetch when
 * there is no snapshot at all. `ensureQueryData` alone would refetch a stale
 * snapshot and fail before the persisted data could be shown.
 */
async function bootstrapSnapshot(queryClient: QueryClient): Promise<BootstrapData> {
  const cached = queryClient.getQueryData<BootstrapData>(queryKeys.bootstrap);
  if (cached) return cached;
  return queryClient.ensureQueryData(bootstrapQueryOptions);
}

function bootstrapTaskPage(
  bootstrap: BootstrapData,
  params: TaskViewParams,
): TaskPage {
  const tagged = new Set(
    params.tagId
      ? (bootstrap.taskTags ?? [])
          .filter((entry) => entry.tagId === params.tagId)
          .map((entry) => entry.taskId)
      : [],
  );
  const visible = bootstrap.tasks
    .filter(
      (task) =>
        (params.includeDone || isOpenTask(task)) &&
        (!params.listId || task.listId === params.listId) &&
        (!params.tagId || tagged.has(task.id)) &&
        taskMatchesBootstrapView(task, params),
    )
    .sort(sortTasks);
  return {
    tasks: visible,
    nextCursor: null,
    hasMore: false,
    source: "bootstrap",
  };
}

function taskMatchesBootstrapView(task: Task, params: TaskViewParams): boolean {
  if (params.listId) return task.listId === params.listId;
  if (!params.view) return true;
  const key = task.nextOccurrenceAt || task.dueAt || task.dueDate;
  const day = task.allDay && task.dueDate
    ? task.dueDate.slice(0, 10)
    : key
      ? localDay(key)
      : null;
  const today = localDay(new Date().toISOString());
  if (params.view === "today") return Boolean(day && day <= today);
  if (params.view === "upcoming") return Boolean(day && day > today);
  if (params.view === "inbox") {
    return !day && isOpenTask(task);
  }
  return true;
}

function localDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Single task, used by the inspector and the /tasks/:id page. */
export function useTaskDetail(taskId: string | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.task(taskId ?? "__none__"),
    queryFn: async ({ signal }) => {
      if (!taskId) throw new Error("No task");
      try {
        const task = await taskApi.get(taskId, signal);
        upsertTaskInCaches(queryClient, task);
        return task;
      } catch (error) {
        if (!shouldUseBootstrapFallback(error)) throw error;
        const cached = getCachedTask(queryClient, taskId);
        if (cached) return cached;
        const bootstrap = await bootstrapSnapshot(queryClient);
        const task = bootstrap.tasks.find((candidate) => candidate.id === taskId);
        if (task) return task;
        throw error;
      }
    },
    enabled: Boolean(taskId),
    initialData: () =>
      taskId ? getCachedTask(queryClient, taskId) : undefined,
    initialDataUpdatedAt: 0,
    staleTime: 10_000,
  });
}

export function useSearchTasks(query: string) {
  const queryClient = useQueryClient();
  const trimmed = query.trim();
  return useQuery({
    queryKey: queryKeys.searchQuery(trimmed),
    queryFn: async ({ signal }) => {
      try {
        return await taskApi.search(trimmed, { signal, limit: 25 });
      } catch (error) {
        if (!shouldUseBootstrapFallback(error)) throw error;
        const bootstrap = await bootstrapSnapshot(queryClient);
        const needle = trimmed.toLowerCase();
        const tasks = bootstrap.tasks
          .filter(
            (task) =>
              task.title.toLowerCase().includes(needle) ||
              (task.notes ?? "").toLowerCase().includes(needle),
          )
          .sort(sortTasks);
        return {
          tasks,
          nextCursor: null,
          hasMore: false,
          source: "bootstrap",
        } satisfies TaskPage;
      }
    },
    enabled: trimmed.length >= 2,
    staleTime: 10_000,
    placeholderData: (previous) => previous,
  });
}

/* -------------------------------------------------------------------------- */
/* Mutation helpers                                                           */
/* -------------------------------------------------------------------------- */

function messageForAction(verb: string, task: Task): string {
  return `${verb} “${task.title}”`;
}

async function freshTask(queryClient: QueryClient, taskId: string): Promise<Task> {
  try {
    const task = await taskApi.get(taskId);
    upsertTaskInCaches(queryClient, task);
    return task;
  } catch (error) {
    const cached = getCachedTask(queryClient, taskId);
    if (cached) return cached;
    throw error;
  }
}

function reportWriteConflict(
  queryClient: QueryClient,
  error: unknown,
  options: {
    task: Task;
    action: string;
    reload?: () => Promise<void>;
    overwrite?: () => Promise<void>;
  },
): void {
  const status = isApiError(error) ? error.status : 0;
  const current = isApiError(error) ? error.current : null;
  if (current) upsertTaskInCaches(queryClient, current);
  reportConflict({
    kind: status === 428 ? "missing-revision" : status === 409 ? "semantic" : "stale",
    title:
      status === 428
        ? "A fresh copy is needed"
        : "This task changed somewhere else",
    message:
      status === 428
        ? `Morrow needs the current revision of “${options.task.title}” before it can ${options.action}. Reload latest, then try again.`
        : `“${options.task.title}” changed on another device or tab. Nothing from this action was saved. Reload the latest copy, or overwrite it with your change.`,
    detail: isApiError(error) ? error.detail : undefined,
    taskTitle: options.task.title,
    currentTask: current,
    reload:
      options.reload ??
      (async () => {
        await invalidateTaskQueries(queryClient);
      }),
    overwrite: options.overwrite,
  });
  announce("Conflict: nothing was overwritten. Review the latest version.");
}

function isPendingSync(task: Task): boolean {
  return task.pendingSync === true;
}

function optimisticTask(input: CreateTaskInput): Task {
  const now = new Date().toISOString();
  return {
    id: input.id,
    title: input.title,
    notes: input.notes ?? null,
    status: "open",
    listId: input.listId ?? null,
    priority: input.priority ?? 0,
    dueAt: input.dueAt ?? null,
    dueDate: input.dueDate ?? null,
    allDay: Boolean(input.allDay),
    timezone: input.timezone ?? null,
    remindAt: input.remindAt ?? null,
    reminderTimeLocal: input.reminderTimeLocal ?? null,
    remindOffsetMinutes: input.remindOffsetMinutes ?? null,
    rrule: input.rrule ?? null,
    dtstartLocal: input.dtstartLocal ?? null,
    nextOccurrenceAt: input.dueAt ?? null,
    nextOccurrenceLocal: input.dtstartLocal ?? null,
    createdAt: now,
    updatedAt: now,
    rev: undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* -------------------------------------------------------------------------- */

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTaskInput): Promise<Task> => {
      const queue = async (): Promise<Task> => {
        await enqueueOutbox({
          kind: "create",
          entityId: input.id,
          payload: { ...input, taskTitle: input.title },
        });
        return { ...optimisticTask(input), pendingSync: true };
      };

      if (typeof navigator !== "undefined" && !navigator.onLine) {
        return queue();
      }
      try {
        return await taskApi.create(input);
      } catch (error) {
        if (error instanceof TypeError) return queue();
        throw error;
      }
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks });
      const snapshot = snapshotTaskCaches(queryClient);
      upsertTaskInCaches(queryClient, optimisticTask(input));
      return { snapshot };
    },
    onError: (error, input, context) => {
      restoreTaskCaches(queryClient, context?.snapshot);
      if (isApiError(error) && error.status === 409) {
        reportConflict({
          kind: "semantic",
          title: "This capture can’t be saved",
          message:
            "Morrow already has a deleted or conflicting item with this identifier. Reload, then capture again.",
          detail: error.detail,
          reload: async () => {
            await invalidateTaskQueries(queryClient);
          },
        });
        return;
      }
      toast.error(apiErrorMessage(error), {
        description: input.title,
      });
    },
    onSuccess: async (task) => {
      upsertTaskInCaches(queryClient, task);
      if (isPendingSync(task)) {
        announce(`Saved “${task.title}” on this device. It will sync when online.`);
        toast("Saved on this device", {
          description: "Morrow will sync this capture when you reconnect.",
        });
        return;
      }
      await invalidateTaskQueries(queryClient);
      pushUndo({
        label: `capture of “${task.title}”`,
        activityId: task.activityId,
        entityId: task.id,
        action: "task.create",
        fallback: async () => {
          const latest = await freshTask(queryClient, task.id);
          await taskApi.remove(latest);
          removeTaskFromCaches(queryClient, task.id);
        },
      });
      announce(`Captured ${task.title}.`);
      toast.success("Captured.", { description: task.title });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      task,
      patch,
    }: {
      task: Task;
      patch: UpdateTaskInput;
      label?: string;
      onResolved?: () => void;
    }) => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        return enqueueOutbox({
          kind: "update",
          entityId: task.id,
          payload: {
            patch,
            rev: task.rev,
            taskTitle: task.title,
          },
        }).then(
          () =>
            ({
              ...task,
              ...patch,
              updatedAt: new Date().toISOString(),
              pendingSync: true,
            }) as Task,
        );
      }
      try {
        return await taskApi.update(task, patch);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        await enqueueOutbox({
          kind: "update",
          entityId: task.id,
          payload: { patch, rev: task.rev, taskTitle: task.title },
        });
        return {
          ...task,
          ...patch,
          updatedAt: new Date().toISOString(),
          pendingSync: true,
        } as Task;
      }
    },
    onMutate: async ({ task, patch }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks });
      const snapshot = snapshotTaskCaches(queryClient);
      mapTaskInCaches(queryClient, task.id, (current) => ({
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
        ...(typeof navigator !== "undefined" && !navigator.onLine
          ? { pendingSync: true }
          : {}),
      }));
      return { snapshot, previous: task };
    },
    onError: (error, { task, patch, onResolved }, context) => {
      restoreTaskCaches(queryClient, context?.snapshot);
      if (isConcurrencyError(error)) {
        reportWriteConflict(queryClient, error, {
          task,
          action: "save",
          reload: async () => {
            await invalidateTaskQueries(queryClient);
            onResolved?.();
          },
          overwrite: async () => {
            const latest = await freshTask(queryClient, task.id);
            const updated = await taskApi.update(latest, patch);
            upsertTaskInCaches(queryClient, updated);
            await invalidateTaskQueries(queryClient);
            announce(`Saved ${updated.title}.`);
            toast.success("Saved with your change.");
            onResolved?.();
          },
        });
        return;
      }
      toast.error(apiErrorMessage(error));
    },
    onSuccess: async (updated, { task, patch, label }) => {
      upsertTaskInCaches(queryClient, updated);
      if (isPendingSync(updated)) {
        announce(`Saved ${updated.title} on this device.`);
        toast("Saved on this device", {
          description: "The edit will sync when Morrow reconnects.",
        });
        return;
      }
      await invalidateTaskQueries(queryClient);

      const previous = task as unknown as Record<string, unknown>;
      const revert: Record<string, unknown> = {};
      for (const key of Object.keys(patch)) {
        if (key in previous) revert[key] = previous[key];
      }
      pushUndo({
        label: label ?? `edit of “${updated.title}”`,
        activityId: updated.activityId,
        entityId: updated.id,
        action: "task.update",
        fallback:
          Object.keys(revert).length > 0
            ? async () => {
                const latest = await freshTask(queryClient, updated.id);
                const reverted = await taskApi.update(
                  latest,
                  revert as UpdateTaskInput,
                );
                upsertTaskInCaches(queryClient, reverted);
              }
            : undefined,
      });
      announce(`${label ?? "Saved"} ${updated.title}.`);
      if (label) toast.success(label);
    },
  });
}

export function useCompleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      task,
      occurrenceKey,
    }: {
      task: Task;
      occurrenceKey?: string;
    }) => {
      try {
        return await taskApi.complete(task, occurrenceKey);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        await enqueueOutbox({
          kind: "complete",
          entityId: task.id,
          payload: {
            rev: task.rev,
            occurrenceKey: occurrenceKey ?? taskOccurrenceKey(task),
            taskTitle: task.title,
          },
        });
        return {
          ...task,
          status: task.rrule ? task.status : "done",
          completedAt: new Date().toISOString(),
          pendingSync: true,
        } as Task;
      }
    },
    onMutate: async ({ task }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks });
      const snapshot = snapshotTaskCaches(queryClient);
      mapTaskInCaches(queryClient, task.id, (current) => ({
        ...current,
        status: current.rrule ? current.status : "done",
        completedAt: new Date().toISOString(),
      }));
      return { snapshot };
    },
    onError: (error, { task }, context) => {
      restoreTaskCaches(queryClient, context?.snapshot);
      if (isConcurrencyError(error)) {
        reportWriteConflict(queryClient, error, {
          task,
          action: "complete",
          overwrite: async () => {
            const latest = await freshTask(queryClient, task.id);
            const completed = await taskApi.complete(
              latest,
              taskOccurrenceKey(latest),
            );
            upsertTaskInCaches(queryClient, completed);
            await invalidateTaskQueries(queryClient);
            announce(`Completed ${completed.title}.`);
            toast.success("Done.");
          },
        });
        return;
      }
      toast.error(apiErrorMessage(error));
    },
    onSuccess: async (completed, { task }) => {
      upsertTaskInCaches(queryClient, completed);
      if (isPendingSync(completed)) {
        announce(`Saved completion of ${completed.title} on this device.`);
        toast("Saved on this device", {
          description: "Completion will sync when Morrow reconnects.",
        });
        return;
      }
      await invalidateTaskQueries(queryClient);

      // Complete is naturally idempotent server-side. If the occurrence was
      // already completed (same rev), don't offer an undo for a no-op.
      if (
        typeof task.rev === "number" &&
        typeof completed.rev === "number" &&
        task.rev === completed.rev
      ) {
        announce(`${completed.title} was already completed.`);
        toast("Already completed", { description: completed.title });
        return;
      }

      pushUndo({
        label: `completion of “${completed.title}”`,
        activityId: completed.activityId,
        entityId: completed.id,
        action: "task.complete",
      });
      announce(`Completed ${completed.title}.`);
      toast.success("Done.", {
        description: completed.title,
        action: {
          label: "Undo",
          onClick: () => {
            void undoLast();
          },
        },
      });
    },
  });
}

export function useSnoozeTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ task, until }: { task: Task; until: string }) => {
      try {
        return await taskApi.snooze(task, until);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        await enqueueOutbox({
          kind: "snooze",
          entityId: task.id,
          payload: { rev: task.rev, until, taskTitle: task.title },
        });
        return { ...task, snoozedUntil: until, pendingSync: true } as Task;
      }
    },
    onMutate: async ({ task, until }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks });
      const snapshot = snapshotTaskCaches(queryClient);
      mapTaskInCaches(queryClient, task.id, (current) => ({
        ...current,
        snoozedUntil: until,
      }));
      return { snapshot };
    },
    onError: (error, { task, until }, context) => {
      restoreTaskCaches(queryClient, context?.snapshot);
      if (isConcurrencyError(error)) {
        reportWriteConflict(queryClient, error, {
          task,
          action: "snooze",
          overwrite: async () => {
            const latest = await freshTask(queryClient, task.id);
            const snoozed = await taskApi.snooze(latest, until);
            upsertTaskInCaches(queryClient, snoozed);
            await invalidateTaskQueries(queryClient);
            toast.success("Snoozed with your change.");
          },
        });
        return;
      }
      toast.error(apiErrorMessage(error));
    },
    onSuccess: async (snoozed) => {
      upsertTaskInCaches(queryClient, snoozed);
      if (isPendingSync(snoozed)) {
        announce(`Saved snooze of ${snoozed.title} on this device.`);
        toast("Saved on this device", {
          description: "Snooze will sync when Morrow reconnects.",
        });
        return;
      }
      await invalidateTaskQueries(queryClient);
      pushUndo({
        label: `snooze of “${snoozed.title}”`,
        activityId: snoozed.activityId,
        entityId: snoozed.id,
        action: "task.snooze",
        fallback: async () => {
          const latest = await freshTask(queryClient, snoozed.id);
          const awake = await taskApi.update(latest, { snoozedUntil: null });
          upsertTaskInCaches(queryClient, awake);
        },
      });
      announce(`Snoozed ${snoozed.title}.`);
      toast.success("Snoozed.", { description: snoozed.title });
    },
  });
}

export function useSkipTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      task,
      occurrenceKey,
    }: {
      task: Task;
      occurrenceKey?: string;
    }) => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        await enqueueOutbox({
          kind: "skip",
          entityId: task.id,
          payload: {
            rev: task.rev,
            occurrenceKey: occurrenceKey ?? taskOccurrenceKey(task),
            taskTitle: task.title,
          },
        });
        return { ...task, pendingSync: true } as Task;
      }
      try {
        return await taskApi.skip(task, occurrenceKey);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        await enqueueOutbox({
          kind: "skip",
          entityId: task.id,
          payload: {
            rev: task.rev,
            occurrenceKey: occurrenceKey ?? taskOccurrenceKey(task),
            taskTitle: task.title,
          },
        });
        return { ...task, pendingSync: true } as Task;
      }
    },
    onMutate: async ({ task }) => {
      if (typeof navigator === "undefined" || navigator.onLine) return;
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks });
      const snapshot = snapshotTaskCaches(queryClient);
      mapTaskInCaches(queryClient, task.id, (current) => ({
        ...current,
        pendingSync: true,
      }));
      return { snapshot };
    },
    onError: (error, { task, occurrenceKey }, context) => {
      restoreTaskCaches(queryClient, context?.snapshot);
      if (isConcurrencyError(error)) {
        reportWriteConflict(queryClient, error, {
          task,
          action: "skip",
          overwrite: async () => {
            const latest = await freshTask(queryClient, task.id);
            const skipped = await taskApi.skip(
              latest,
              occurrenceKey ?? taskOccurrenceKey(latest),
            );
            upsertTaskInCaches(queryClient, skipped);
            await invalidateTaskQueries(queryClient);
            toast.success("Occurrence skipped.");
          },
        });
        return;
      }
      toast.error(apiErrorMessage(error));
    },
    onSuccess: async (skipped, { task }) => {
      upsertTaskInCaches(queryClient, skipped);
      if (isPendingSync(skipped)) {
        announce(`Saved skip of ${skipped.title} on this device.`);
        toast("Saved on this device", {
          description: "The skipped occurrence will sync when Morrow reconnects.",
        });
        return;
      }
      await invalidateTaskQueries(queryClient);
      if (
        typeof task.rev === "number" &&
        typeof skipped.rev === "number" &&
        task.rev === skipped.rev
      ) {
        announce("That occurrence was already skipped.");
        toast("Already skipped", { description: skipped.title });
        return;
      }
      pushUndo({
        label: `skip of “${skipped.title}”`,
        activityId: skipped.activityId,
        entityId: skipped.id,
        action: "task.skip",
      });
      announce(`Skipped this occurrence of ${skipped.title}.`);
      toast.success("Occurrence skipped.", { description: skipped.title });
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (task: Task) => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        await enqueueOutbox({
          kind: "delete",
          entityId: task.id,
          payload: { rev: task.rev, taskTitle: task.title },
        });
        return;
      }
      try {
        await taskApi.remove(task);
        return { queued: false };
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        await enqueueOutbox({
          kind: "delete",
          entityId: task.id,
          payload: { rev: task.rev, taskTitle: task.title },
        });
        return { queued: true };
      }
    },
    onMutate: async (task) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks });
      const snapshot = snapshotTaskCaches(queryClient);
      const queued =
        typeof navigator !== "undefined" && !navigator.onLine;
      removeTaskFromCaches(queryClient, task.id);
      return { snapshot, queued };
    },
    onError: (error, task, context) => {
      restoreTaskCaches(queryClient, context?.snapshot);
      if (isConcurrencyError(error)) {
        reportWriteConflict(queryClient, error, {
          task,
          action: "delete",
          overwrite: async () => {
            const latest = await freshTask(queryClient, task.id);
            await taskApi.remove(latest);
            removeTaskFromCaches(queryClient, task.id);
            await invalidateTaskQueries(queryClient);
            toast.success("Deleted.");
          },
        });
        return;
      }
      toast.error(apiErrorMessage(error));
    },
    onSuccess: async (result, task, context) => {
      if (result?.queued || context?.queued) {
        announce(`Saved deletion of ${task.title} on this device.`);
        toast("Saved on this device", {
          description: "The deletion will sync when Morrow reconnects.",
        });
        return;
      }
      await invalidateTaskQueries(queryClient);
      pushUndo({
        label: `deletion of “${task.title}”`,
        entityId: task.id,
        action: "task.delete",
      });
      announce(`Deleted ${task.title}.`);
      toast.success("Deleted.", {
        description: "Undo is available from the command palette or Cmd+Z.",
      });
    },
  });
}

export function useCreateList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateListInput) => listApi.create(input),
    onSuccess: async (list: TaskList) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap });
      announce(`Created list ${list.name ?? "Untitled"}.`);
      toast.success(`“${list.name || list.title || "List"}” added.`);
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
}

export function useUpdateList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      list,
      patch,
    }: {
      list: TaskList;
      patch: UpdateListInput;
    }) => listApi.update(list, patch),
    onSuccess: async (updated) => {
      const bootstrap = queryClient.getQueryData<BootstrapData>(queryKeys.bootstrap);
      if (bootstrap) {
        queryClient.setQueryData(queryKeys.bootstrap, {
          ...bootstrap,
          lists: bootstrap.lists.map((list) =>
            list.id === updated.id ? updated : list,
          ),
        });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap });
      announce(`Saved list ${updated.name ?? "Untitled"}.`);
      toast.success("List saved.");
    },
    onError: (error) => {
      if (isConcurrencyError(error)) {
        reportConflict({
          kind: "stale",
          title: "This list changed somewhere else",
          message:
            "Reload the latest list before saving. Nothing was overwritten.",
          reload: async () => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap });
          },
        });
        return;
      }
      toast.error(apiErrorMessage(error));
    },
  });
}

export function useDeleteList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (list: TaskList) => listApi.remove(list),
    onSuccess: async (_result, list) => {
      await invalidateTaskQueries(queryClient);
      announce(`Deleted list ${list.name ?? "Untitled"}.`);
      toast.success("List deleted.", {
        description: "Its tasks are kept and can still be found in Inbox.",
      });
    },
    onError: (error) => {
      if (isConcurrencyError(error)) {
        reportConflict({
          kind: "stale",
          title: "This list changed somewhere else",
          message: "Reload before deleting. Nothing was deleted.",
          reload: async () => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap });
          },
        });
        return;
      }
      toast.error(apiErrorMessage(error));
    },
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.updateSettings(patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap });
      toast.success("Settings saved.");
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
}

/* -------------------------------------------------------------------------- */
/* Row/detail actions                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Complete/snooze/skip for a row or the inspector. Create, edits, complete,
 * snooze, skip, and delete are queued in the outbox while offline; the queue
 * preserves conflicts instead of silently overwriting (plan §7).
 */
export function useTaskActions() {
  const queryClient = useQueryClient();
  const completeMutation = useCompleteTask();
  const snoozeMutation = useSnoozeTask();
  const skipMutation = useSkipTask();

  const complete = useCallback(
    (task: Task) => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        const snapshot = snapshotTaskCaches(queryClient);
        mapTaskInCaches(queryClient, task.id, (current) => ({
          ...current,
          status: current.rrule ? current.status : "done",
          completedAt: new Date().toISOString(),
        }));
        void enqueueOutbox({
          kind: "complete",
          entityId: task.id,
          payload: {
            rev: task.rev,
            occurrenceKey: taskOccurrenceKey(task),
            taskTitle: task.title,
          },
        })
          .then(() => {
            announce(`Saved completion of ${task.title} on this device.`);
            toast("Saved on this device", {
              description: "Completion will sync when you reconnect.",
            });
          })
          .catch((error: unknown) => {
            restoreTaskCaches(queryClient, snapshot);
            toast.error(apiErrorMessage(error));
          });
        return;
      }
      completeMutation.mutate({
        task,
        occurrenceKey: taskOccurrenceKey(task),
      });
    },
    [completeMutation, queryClient],
  );

  const snooze = useCallback(
    (task: Task, until: Date) => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        const snapshot = snapshotTaskCaches(queryClient);
        mapTaskInCaches(queryClient, task.id, (current) => ({
          ...current,
          snoozedUntil: until.toISOString(),
        }));
        void enqueueOutbox({
          kind: "snooze",
          entityId: task.id,
          payload: {
            rev: task.rev,
            until: until.toISOString(),
            taskTitle: task.title,
          },
        })
          .then(() => {
            announce(`Saved snooze of ${task.title} on this device.`);
            toast("Saved on this device", {
              description: "Snooze will sync when you reconnect.",
            });
          })
          .catch((error: unknown) => {
            restoreTaskCaches(queryClient, snapshot);
            toast.error(apiErrorMessage(error));
          });
        return;
      }
      snoozeMutation.mutate({ task, until: until.toISOString() });
    },
    [queryClient, snoozeMutation],
  );

  const skip = useCallback(
    (task: Task) => {
      skipMutation.mutate({
        task,
        occurrenceKey: taskOccurrenceKey(task),
      });
    },
    [skipMutation],
  );

  return {
    complete,
    snooze,
    skip,
    completing: completeMutation.isPending,
    snoozing: snoozeMutation.isPending,
    skipping: skipMutation.isPending,
  };
}
