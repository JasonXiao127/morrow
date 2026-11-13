import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import type { BootstrapData, Task } from "@/api";
import { addDays, dateKey } from "../src/lib/format.js";
import { queryKeys } from "../src/lib/query.js";
import {
  activityIdOf,
  getCachedTask,
  mapTaskInCaches,
  removeTaskFromCaches,
  restoreTaskCaches,
  snapshotTaskCaches,
  taskMatchesListKey,
  upsertTaskInCaches,
} from "../src/lib/task-cache.js";
import { makePage, makeTask } from "./helpers.js";

function bootstrap(tasks: Task[]): BootstrapData {
  return { lists: [], tasks, cursor: 10 };
}

function pages(
  client: QueryClient,
  key: readonly unknown[],
): Array<{ tasks: Task[] }> {
  const data = client.getQueryData(key) as
    | { pages: Array<{ tasks: Task[] }> }
    | undefined;
  return data?.pages ?? [];
}

function cachedBootstrap(client: QueryClient): BootstrapData | undefined {
  return client.getQueryData(queryKeys.bootstrap) as BootstrapData | undefined;
}

describe("task cache mutations", () => {
  let client: QueryClient;
  let todayList: readonly unknown[];
  let inboxList: readonly unknown[];

  beforeEach(() => {
    client = new QueryClient();
    todayList = queryKeys.taskList({ view: "today" });
    inboxList = queryKeys.taskList({ view: "inbox" });
  });

  it("updates every paginated copy, the detail, and bootstrap", () => {
    const a = makeTask({
      id: "a",
      title: "Alpha",
      allDay: true,
      dueDate: "2026-07-15",
    });
    const b = makeTask({ id: "b", title: "Beta" });
    client.setQueryData(todayList, {
      pages: [makePage([a, b]), makePage([a], "next")],
      pageParams: [null, "next"],
    });
    client.setQueryData(queryKeys.task("a"), a);
    client.setQueryData(queryKeys.bootstrap, bootstrap([a, b]));

    mapTaskInCaches(client, "a", (task) => ({
      ...task,
      title: "Alpha updated",
      rev: 2,
    }));

    const updatedPages = pages(client, todayList);
    expect(updatedPages[0]?.tasks.map((task) => task.title)).toEqual([
      "Alpha updated",
      "Beta",
    ]);
    expect(updatedPages[1]?.tasks.map((task) => task.title)).toEqual([
      "Alpha updated",
    ]);
    expect(client.getQueryData(queryKeys.task("a"))).toMatchObject({
      title: "Alpha updated",
      rev: 2,
    });
    expect(cachedBootstrap(client)?.tasks.map((task) => task.title)).toEqual([
      "Alpha updated",
      "Beta",
    ]);
  });

  it("removes a task from pages and bootstrap when the updater returns null", () => {
    const a = makeTask({ id: "a", title: "Alpha" });
    const b = makeTask({ id: "b", title: "Beta" });
    client.setQueryData(todayList, {
      pages: [makePage([a, b]), makePage([a])],
      pageParams: [null, "next"],
    });
    client.setQueryData(queryKeys.task("a"), a);
    client.setQueryData(queryKeys.bootstrap, bootstrap([a, b]));

    mapTaskInCaches(client, "a", () => null);

    const remaining = pages(client, todayList);
    expect(remaining).toHaveLength(2);
    expect(remaining[0]?.tasks.map((task) => task.id)).toEqual(["b"]);
    expect(remaining[1]?.tasks).toEqual([]);
    expect(cachedBootstrap(client)?.tasks.map((task) => task.id)).toEqual([
      "b",
    ]);
  });

  it("snapshots and restores the caches for optimistic rollback", () => {
    const a = makeTask({ id: "a", title: "Original" });
    client.setQueryData(todayList, {
      pages: [makePage([a])],
      pageParams: [null],
    });
    client.setQueryData(queryKeys.task("a"), a);
    client.setQueryData(queryKeys.bootstrap, bootstrap([a]));

    const snapshot = snapshotTaskCaches(client);
    expect(snapshot.entries).toHaveLength(3);

    mapTaskInCaches(client, "a", (task) => ({
      ...task,
      title: "Optimistic",
    }));
    expect(cachedBootstrap(client)?.tasks[0]?.title).toBe("Optimistic");

    restoreTaskCaches(client, snapshot);

    expect(pages(client, todayList)[0]?.tasks[0]?.title).toBe("Original");
    expect(client.getQueryData(queryKeys.task("a"))).toMatchObject({
      title: "Original",
    });
    expect(cachedBootstrap(client)?.tasks[0]?.title).toBe("Original");
  });

  it("skips non-task queries in a snapshot and ignores an undefined restore", () => {
    client.setQueryData(queryKeys.session, { user: { id: "me" } });
    client.setQueryData(queryKeys.search, { results: [] });
    client.setQueryData(queryKeys.bootstrap, bootstrap([]));

    const snapshot = snapshotTaskCaches(client);
    expect(snapshot.entries).toEqual([[queryKeys.bootstrap, bootstrap([])]]);

    expect(() => restoreTaskCaches(client, undefined)).not.toThrow();
  });

  it("updates an existing task once instead of duplicating it", () => {
    const a = makeTask({ id: "a", title: "Old" });
    const b = makeTask({ id: "b", title: "Beta" });
    client.setQueryData(todayList, {
      pages: [makePage([a, b])],
      pageParams: [null],
    });
    client.setQueryData(queryKeys.task("a"), a);
    client.setQueryData(queryKeys.bootstrap, bootstrap([a]));

    upsertTaskInCaches(client, { ...a, title: "New", rev: 2 });

    expect(pages(client, todayList)[0]?.tasks).toHaveLength(2);
    expect(pages(client, todayList)[0]?.tasks[0]).toMatchObject({
      id: "a",
      title: "New",
    });
    expect(cachedBootstrap(client)?.tasks).toHaveLength(1);
  });

  it("adds a new task only to matching lists and bootstrap", () => {
    const todayTask = makeTask({
      id: "today-task",
      allDay: true,
      dueDate: dateKey(new Date()),
    });
    client.setQueryData(todayList, {
      pages: [makePage([todayTask])],
      pageParams: [null],
    });
    client.setQueryData(inboxList, {
      pages: [makePage([])],
      pageParams: [null],
    });
    client.setQueryData(queryKeys.bootstrap, bootstrap([todayTask]));

    const inboxTask = makeTask({ id: "inbox-task", title: "Inbox task" });
    upsertTaskInCaches(client, inboxTask);

    expect(pages(client, inboxList)[0]?.tasks.map((task) => task.id)).toEqual([
      "inbox-task",
    ]);
    expect(pages(client, todayList)[0]?.tasks.map((task) => task.id)).toEqual([
      "today-task",
    ]);
    expect(cachedBootstrap(client)?.tasks[0]?.id).toBe("inbox-task");
    expect(cachedBootstrap(client)?.tasks).toHaveLength(2);

    const upcoming = makeTask({
      id: "upcoming-task",
      allDay: true,
      dueDate: dateKey(addDays(new Date(), 2)),
    });
    upsertTaskInCaches(client, upcoming);
    expect(pages(client, todayList)[0]?.tasks).toHaveLength(1);
    expect(pages(client, inboxList)[0]?.tasks).toHaveLength(1);
  });

  it("removes a task and its detail query entry", () => {
    const a = makeTask({ id: "a" });
    client.setQueryData(todayList, {
      pages: [makePage([a])],
      pageParams: [null],
    });
    client.setQueryData(queryKeys.task("a"), a);
    client.setQueryData(queryKeys.bootstrap, bootstrap([a]));

    removeTaskFromCaches(client, "a");

    expect(pages(client, todayList)[0]?.tasks).toEqual([]);
    expect(cachedBootstrap(client)?.tasks).toEqual([]);
    expect(
      client
        .getQueryCache()
        .find({ queryKey: queryKeys.task("a"), exact: true }),
    ).toBeUndefined();
  });
});

describe("task cache lookups and list matching", () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient();
  });

  it("prefers detail, then paginated lists, then bootstrap", () => {
    const listTask = makeTask({ id: "a", title: "From list" });
    const bootstrapTask = makeTask({ id: "a", title: "From bootstrap" });
    client.setQueryData(queryKeys.taskList({ view: "inbox" }), {
      pages: [makePage([listTask])],
      pageParams: [null],
    });
    client.setQueryData(queryKeys.bootstrap, bootstrap([bootstrapTask]));

    expect(getCachedTask(client, "a")?.title).toBe("From list");

    client.setQueryData(
      queryKeys.task("a"),
      makeTask({ id: "a", title: "From detail" }),
    );
    expect(getCachedTask(client, "a")?.title).toBe("From detail");

    client.removeQueries({ queryKey: queryKeys.tasks });
    expect(getCachedTask(client, "a")?.title).toBe("From bootstrap");
    expect(getCachedTask(client, "missing")).toBeUndefined();
  });

  it("matches list-id, today, upcoming, inbox, and default views", () => {
    const today = dateKey(new Date());
    const tomorrow = dateKey(addDays(new Date(), 1));

    const listTask = makeTask({ id: "l", listId: "list-1" });
    expect(taskMatchesListKey(listTask, { listId: "list-1" })).toBe(true);
    expect(taskMatchesListKey(listTask, { listId: "list-2" })).toBe(false);

    const todayTask = makeTask({
      id: "today",
      allDay: true,
      dueDate: today,
    });
    const tomorrowTask = makeTask({
      id: "tomorrow",
      allDay: true,
      dueDate: tomorrow,
    });
    expect(taskMatchesListKey(todayTask, { view: "today" })).toBe(true);
    expect(taskMatchesListKey(tomorrowTask, { view: "today" })).toBe(false);
    expect(taskMatchesListKey(todayTask, { view: "upcoming" })).toBe(false);
    expect(taskMatchesListKey(tomorrowTask, { view: "upcoming" })).toBe(true);

    const inboxTask = makeTask({ id: "inbox" });
    expect(taskMatchesListKey(inboxTask, { view: "inbox" })).toBe(true);
    expect(taskMatchesListKey(todayTask, { view: "inbox" })).toBe(false);
    expect(taskMatchesListKey(inboxTask, {})).toBe(true);
  });

  it("returns only usable activity ids", () => {
    expect(activityIdOf(makeTask({ activityId: "activity-1" }))).toBe(
      "activity-1",
    );
    expect(activityIdOf(makeTask({ activityId: 9 }))).toBe(9);
    expect(activityIdOf(makeTask({ activityId: "   " }))).toBeNull();
    expect(activityIdOf(makeTask({ activityId: null }))).toBeNull();
    expect(activityIdOf(makeTask({ activityId: Number.NaN }))).toBeNull();
    expect(activityIdOf(undefined)).toBeNull();
  });
});
