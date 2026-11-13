import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import type { BootstrapData, Task, TaskPage } from "@/api";
import { taskDayKey, todayKeyInZone } from "./format";
import { queryKeys, type TaskListKey } from "./query";

/**
 * Helpers that keep every cached representation of a task consistent:
 * paginated view lists, the single-task detail query, and bootstrap (used for
 * sidebar counts, list counts, and the Today "completed" group).
 */

interface TaskPages extends InfiniteData<TaskPage, unknown> {}

export interface TaskCacheSnapshot {
  entries: Array<[QueryKey, unknown]>;
}

function isTaskPages(value: unknown): value is TaskPages {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { pages?: unknown };
  return Array.isArray(candidate.pages);
}

function isBootstrap(value: unknown): value is BootstrapData {
  if (!value || typeof value !== "object") return false;
  return Array.isArray((value as BootstrapData).tasks);
}

function patchPages(
  data: TaskPages,
  id: string,
  updater: (task: Task) => Task | null,
): TaskPages {
  let changed = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const tasks: Task[] = [];
    for (const task of page.tasks) {
      if (task.id !== id) {
        tasks.push(task);
        continue;
      }
      const next = updater(task);
      pageChanged = true;
      if (next) tasks.push(next);
    }
    if (!pageChanged) return page;
    changed = true;
    return { ...page, tasks };
  });
  return changed ? { ...data, pages } : data;
}

export function taskCacheQueries(client: QueryClient) {
  return client
    .getQueryCache()
    .getAll()
    .filter((query) => {
      const key = query.queryKey;
      return key[0] === queryKeys.tasks[0];
    });
}

export function snapshotTaskCaches(client: QueryClient): TaskCacheSnapshot {
  const entries: Array<[QueryKey, unknown]> = [];
  for (const query of taskCacheQueries(client)) {
    entries.push([query.queryKey, query.state.data]);
  }
  const bootstrap = client.getQueryData<BootstrapData>(queryKeys.bootstrap);
  if (bootstrap) entries.push([queryKeys.bootstrap, bootstrap]);
  return { entries };
}

export function restoreTaskCaches(
  client: QueryClient,
  snapshot: TaskCacheSnapshot | undefined,
): void {
  if (!snapshot) return;
  for (const [key, data] of snapshot.entries) {
    client.setQueryData(key, data);
  }
}

/** Apply a local edit to every cached copy of one task. */
export function mapTaskInCaches(
  client: QueryClient,
  id: string,
  updater: (task: Task) => Task | null,
): void {
  for (const query of taskCacheQueries(client)) {
    const key = query.queryKey;
    if (key[1] === "detail") {
      const task = query.state.data as Task | undefined;
      if (task?.id === id) {
        const next = updater(task);
        client.setQueryData(key, next ?? undefined);
      }
      continue;
    }
    if (key[1] === "list") {
      const data = query.state.data;
      if (isTaskPages(data)) {
        client.setQueryData(key, patchPages(data, id, updater));
      }
    }
  }

  const bootstrap = client.getQueryData<BootstrapData>(queryKeys.bootstrap);
  if (bootstrap) {
    let changed = false;
    const tasks: Task[] = [];
    for (const task of bootstrap.tasks) {
      if (task.id !== id) {
        tasks.push(task);
        continue;
      }
      const next = updater(task);
      changed = true;
      if (next) tasks.push(next);
    }
    if (changed) client.setQueryData(queryKeys.bootstrap, { ...bootstrap, tasks });
  }
}

export function getCachedTask(
  client: QueryClient,
  id: string,
): Task | undefined {
  const detail = client.getQueryData<Task>(queryKeys.task(id));
  if (detail?.id === id) return detail;

  for (const query of taskCacheQueries(client)) {
    if (query.queryKey[1] !== "list") continue;
    const data = query.state.data;
    if (!isTaskPages(data)) continue;
    for (const page of data.pages) {
      const task = page.tasks.find((candidate) => candidate.id === id);
      if (task) return task;
    }
  }

  const bootstrap = client.getQueryData<BootstrapData>(queryKeys.bootstrap);
  return bootstrap?.tasks.find((task) => task.id === id);
}

export function taskMatchesListKey(
  task: Task,
  key: TaskListKey,
  timeZone?: string,
): boolean {
  if (key.listId) return task.listId === key.listId;
  const day = taskDayKey(task, timeZone);
  const today = todayKeyInZone(timeZone);
  switch (key.view) {
    case "today":
      return Boolean(day && day <= today);
    case "upcoming":
      return Boolean(day && day > today);
    case "inbox":
      return !day;
    default:
      return true;
  }
}

/**
 * Update a task if present; otherwise add it to matching lists. Used after a
 * successful create/update where the server returns a new revision.
 */
export function upsertTaskInCaches(client: QueryClient, task: Task): void {
  mapTaskInCaches(client, task.id, () => task);

  const bootstrap = client.getQueryData<BootstrapData>(queryKeys.bootstrap);
  const zone = bootstrap?.user?.timezone ?? undefined;
  for (const query of taskCacheQueries(client)) {
    const key = query.queryKey;
    if (key[1] !== "list") continue;
    const params = key[2] as TaskListKey | undefined;
    if (!params || !taskMatchesListKey(task, params, zone)) continue;
    const data = query.state.data;
    if (!isTaskPages(data)) continue;
    const exists = data.pages.some((page) =>
      page.tasks.some((candidate) => candidate.id === task.id),
    );
    if (exists) continue;
    const [first, ...rest] = data.pages;
    if (!first) continue;
    client.setQueryData(key, {
      ...data,
      pages: [{ ...first, tasks: [task, ...first.tasks] }, ...rest],
    });
  }

  if (bootstrap && !bootstrap.tasks.some((candidate) => candidate.id === task.id)) {
    client.setQueryData(queryKeys.bootstrap, {
      ...bootstrap,
      tasks: [task, ...bootstrap.tasks],
    });
  }
}

export function removeTaskFromCaches(client: QueryClient, id: string): void {
  mapTaskInCaches(client, id, () => null);
  client.removeQueries({ queryKey: queryKeys.task(id), exact: true });
}

/** Extract the activity cursor a mutation response attached, if any. */
export function activityIdOf(task: Task | undefined): string | number | null {
  if (!task) return null;
  const value = task.activityId;
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}
