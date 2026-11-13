import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Task } from "@/api";
import type { OutboxRecord } from "@/lib/idb";
import {
  enqueueOutbox,
  getOutboxConflicts,
  lastSyncedAt,
  listOutbox,
  markOutboxAttempt,
  replayOutbox,
  retryOutboxRecord,
} from "@/lib/outbox";
import { MemoryStorage, makeTask } from "./helpers.js";

const apiMocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api")>();
  return {
    ...actual,
    apiFetch: apiMocks.apiFetch,
    taskApi: {
      ...actual.taskApi,
      create: apiMocks.create,
      get: apiMocks.get,
    },
  };
});

const idbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("@/lib/idb", () => ({
  getDb: idbMocks.getDb,
}));

class FakeDb {
  readonly records = new Map<string, OutboxRecord>();

  async add(_store: string, record: OutboxRecord): Promise<string> {
    this.records.set(record.opId, structuredClone(record));
    return record.opId;
  }

  async get(_store: string, id: string): Promise<OutboxRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async put(_store: string, record: OutboxRecord): Promise<string> {
    this.records.set(record.opId, structuredClone(record));
    return record.opId;
  }

  async delete(_store: string, id: string): Promise<void> {
    this.records.delete(id);
  }

  async count(): Promise<number> {
    return this.records.size;
  }

  async getAllFromIndex(): Promise<OutboxRecord[]> {
    return [...this.records.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((record) => structuredClone(record));
  }
}

describe("offline outbox", () => {
  let db: FakeDb;
  let storage: MemoryStorage;

  beforeEach(() => {
    db = new FakeDb();
    storage = new MemoryStorage();
    idbMocks.getDb.mockResolvedValue(db as never);
    apiMocks.apiFetch.mockReset().mockResolvedValue({});
    apiMocks.create.mockReset().mockResolvedValue(makeTask());
    apiMocks.get.mockReset();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", new EventTarget());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports an empty queue without calling the API", async () => {
    const result = await replayOutbox();
    expect(result).toEqual({
      replayed: 0,
      remaining: 0,
      conflicts: 0,
      stoppedBy: "empty",
    });
    expect(apiMocks.apiFetch).not.toHaveBeenCalled();
    expect(apiMocks.create).not.toHaveBeenCalled();
  });

  it("replays creates, completes, and snoozes in FIFO order", async () => {
    const calls: string[] = [];
    apiMocks.create.mockImplementation(async (input: { id: string }) => {
      calls.push(`create:${input.id}`);
      return makeTask({ id: input.id });
    });
    apiMocks.apiFetch.mockImplementation(async (path: string) => {
      calls.push(`fetch:${path}`);
      return {};
    });

    const created = await enqueueOutbox({
      kind: "create",
      entityId: "task-create",
      payload: {
        taskTitle: "local-only label",
        title: "New task",
        id: "task-create",
      },
    });
    const completed = await enqueueOutbox({
      kind: "complete",
      entityId: "task-complete",
      payload: { rev: 3, occurrenceKey: "2026-07-15" },
    });
    const snoozed = await enqueueOutbox({
      kind: "snooze",
      entityId: "task-snooze",
      payload: { rev: 4, until: "2026-07-15T09:00:00.000Z" },
    });

    const result = await replayOutbox();

    expect(calls).toEqual([
      "create:task-create",
      "fetch:/tasks/task-complete/complete",
      "fetch:/tasks/task-snooze/snooze",
    ]);
    expect(result).toEqual({
      replayed: 3,
      remaining: 0,
      conflicts: 0,
      stoppedBy: undefined,
    });
    expect(db.records.size).toBe(0);

    const createInput = apiMocks.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(createInput).toMatchObject({
      id: "task-create",
      title: "New task",
    });
    expect(createInput).not.toHaveProperty("taskTitle");

    const completeCall = apiMocks.apiFetch.mock.calls[0]?.[1] as {
      headers: Record<string, string>;
      body: Record<string, unknown>;
    };
    expect(completeCall.headers).toMatchObject({
      "Idempotency-Key": completed.opId,
      "If-Match": '"rev-3"',
    });
    expect(completeCall.body).toEqual({ occurrenceKey: "2026-07-15" });

    const snoozeCall = apiMocks.apiFetch.mock.calls[1]?.[1] as {
      headers: Record<string, string>;
      body: Record<string, unknown>;
    };
    expect(snoozeCall.headers).toMatchObject({
      "Idempotency-Key": snoozed.opId,
      "If-Match": '"rev-4"',
    });
    expect(snoozeCall.body).toEqual({ until: "2026-07-15T09:00:00.000Z" });

    expect(lastSyncedAt()).toBeTruthy();
    expect(created.opId).not.toBe(completed.opId);
  });

  it("replays offline edits, skips, and deletes with their revisions", async () => {
    const calls: Array<{ path: string; init: Record<string, unknown> }> = [];
    apiMocks.apiFetch.mockImplementation(
      async (path: string, init: Record<string, unknown>) => {
        calls.push({ path, init });
        return {};
      },
    );

    await enqueueOutbox({
      kind: "update",
      entityId: "task-edit",
      payload: { rev: 5, patch: { title: "Renamed offline" } },
    });
    await enqueueOutbox({
      kind: "skip",
      entityId: "task-skip",
      payload: { rev: 6, occurrenceKey: "2026-07-15" },
    });
    await enqueueOutbox({
      kind: "delete",
      entityId: "task-delete",
      payload: { rev: 7 },
    });

    const result = await replayOutbox();

    expect(result).toMatchObject({ replayed: 3, remaining: 0 });
    expect(calls.map((call) => call.path)).toEqual([
      "/tasks/task-edit",
      "/tasks/task-skip/skip",
      "/tasks/task-delete",
    ]);
    const [edit, skip, remove] = calls;
    expect(edit?.init["method"]).toBe("PATCH");
    expect(edit?.init["body"]).toEqual({ title: "Renamed offline" });
    expect((edit?.init["headers"] as Record<string, string>)["If-Match"]).toBe(
      '"rev-5"',
    );
    expect(skip?.init["method"]).toBe("POST");
    expect(skip?.init["body"]).toEqual({ occurrenceKey: "2026-07-15" });
    expect((skip?.init["headers"] as Record<string, string>)["If-Match"]).toBe(
      '"rev-6"',
    );
    expect(remove?.init["method"]).toBe("DELETE");
    expect((remove?.init["headers"] as Record<string, string>)["If-Match"]).toBe(
      '"rev-7"',
    );
  });

  it("resolves the server revision for a chained op on an offline create", async () => {
    apiMocks.create.mockResolvedValue(
      makeTask({ id: "task-created", rev: 1 }),
    );
    apiMocks.get.mockResolvedValue(
      makeTask({ id: "task-created", rev: 1 }),
    );
    apiMocks.apiFetch.mockResolvedValue({});

    await enqueueOutbox({
      kind: "create",
      entityId: "task-created",
      payload: { title: "Offline", id: "task-created" },
    });
    await enqueueOutbox({
      kind: "update",
      entityId: "task-created",
      payload: { patch: { title: "Offline edited" } },
    });

    const result = await replayOutbox();

    expect(result).toMatchObject({ replayed: 2, remaining: 0 });
    expect(apiMocks.get).toHaveBeenCalledWith("task-created");
    const call = apiMocks.apiFetch.mock.calls[0]?.[1] as {
      headers: Record<string, string>;
      body: Record<string, unknown>;
    };
    expect(call.headers["If-Match"]).toBe('"rev-1"');
    expect(call.body).toEqual({ title: "Offline edited" });
  });

  it("coalesces overlapping replays in the same tab", async () => {
    await enqueueOutbox({
      kind: "complete",
      entityId: "task-1",
      payload: { rev: 1 },
    });

    let release: ((value: unknown) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    apiMocks.apiFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
          signalStarted?.();
        }),
    );

    const first = replayOutbox();
    const second = replayOutbox();
    expect(second).toBe(first);

    await started;
    expect(apiMocks.apiFetch).toHaveBeenCalledTimes(1);
    release?.({});
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(firstResult.replayed).toBe(1);
    expect(firstResult.remaining).toBe(0);
    expect(apiMocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("stops on a conflict, keeps later operations queued, and marks the record", async () => {
    await enqueueOutbox({
      kind: "complete",
      entityId: "task-1",
      payload: { rev: 1 },
    });
    await enqueueOutbox({
      kind: "snooze",
      entityId: "task-2",
      payload: { rev: 2, until: "2026-07-15T09:00:00.000Z" },
    });
    await enqueueOutbox({
      kind: "complete",
      entityId: "task-3",
      payload: { rev: 3 },
    });

    apiMocks.apiFetch.mockRejectedValueOnce(
      new ApiError(412, { detail: "This changed on another device." }, "stale"),
    );

    const result = await replayOutbox();

    expect(result).toMatchObject({
      replayed: 0,
      remaining: 3,
      conflicts: 1,
      stoppedBy: "conflict",
    });
    expect(apiMocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(db.records.size).toBe(3);

    const [record] = await listOutbox();
    expect(record).toMatchObject({
      entityId: "task-1",
      attempts: 1,
      conflict: true,
      lastError:
        "This changed on another device. Refresh and try again.",
    });
    await expect(getOutboxConflicts()).resolves.toBe(1);
    expect(lastSyncedAt()).toBeNull();
  });

  it.each([
    { status: 428, stoppedBy: "conflict", conflict: true },
    { status: 422, stoppedBy: "error", conflict: false },
    { status: 503, stoppedBy: "offline", conflict: false },
  ])(
    "classifies an HTTP $status failure as $stoppedBy",
    async ({ status, stoppedBy, conflict }) => {
      await enqueueOutbox({
        kind: "complete",
        entityId: "task-1",
        payload: { rev: 1 },
      });
      apiMocks.apiFetch.mockRejectedValue(
        new ApiError(status, { detail: `failure ${status}` }, "failed"),
      );

      const result = await replayOutbox();

      expect(result.stoppedBy).toBe(stoppedBy);
      expect(result.replayed).toBe(0);
      expect(result.remaining).toBe(1);
      expect(result.conflicts).toBe(conflict ? 1 : 0);
      const [record] = await listOutbox();
      expect(Boolean(record?.conflict)).toBe(conflict);
      expect(record?.attempts).toBe(1);
    },
  );

  it("does not touch the queue while offline", async () => {
    await enqueueOutbox({
      kind: "complete",
      entityId: "task-1",
      payload: { rev: 1 },
    });
    vi.stubGlobal("navigator", { onLine: false });

    const result = await replayOutbox();

    expect(result).toMatchObject({
      replayed: 0,
      remaining: 1,
      stoppedBy: "offline",
    });
    expect(apiMocks.apiFetch).not.toHaveBeenCalled();
    expect(db.records.size).toBe(1);
  });

  it("re-bases a conflicted completion on the current revision before retrying", async () => {
    const queued = await enqueueOutbox({
      kind: "complete",
      entityId: "task-1",
      payload: { rev: 1, occurrenceKey: "2026-07-01" },
    });
    await markOutboxAttempt(queued.opId, "stale", true);

    apiMocks.get.mockResolvedValue(
      makeTask({
        id: "task-1",
        rev: 9,
        dueAt: "2026-07-15T13:30:00.000Z",
      }),
    );
    apiMocks.apiFetch.mockResolvedValue({});

    const result = await retryOutboxRecord(queued.opId);

    expect(apiMocks.get).toHaveBeenCalledWith("task-1");
    expect(result).toMatchObject({
      replayed: 1,
      remaining: 0,
      conflicts: 0,
    });

    const call = apiMocks.apiFetch.mock.calls[0]?.[1] as {
      headers: Record<string, string>;
      body: Record<string, unknown>;
    };
    expect(call.headers["If-Match"]).toBe('"rev-9"');
    expect(call.body).toEqual({
      occurrenceKey: "2026-07-15T13:30:00.000Z",
    });
    expect(db.records.size).toBe(0);
  });

  it("returns an empty result when retrying an unknown operation", async () => {
    const result = await retryOutboxRecord("missing-op");
    expect(result).toEqual({
      replayed: 0,
      remaining: 0,
      conflicts: 0,
      stoppedBy: "empty",
    });
    expect(apiMocks.apiFetch).not.toHaveBeenCalled();
  });

  it("advances queued revisions after a successful replay", async () => {
    const calls: Array<{
      path: string;
      method?: string;
      ifMatch?: string;
    }> = [];
    apiMocks.apiFetch.mockImplementation(
      async (
        path: string,
        options: {
          method?: string;
          headers?: Record<string, string>;
        } = {},
      ) => {
        calls.push({
          path,
          method: options.method,
          ifMatch: options.headers?.["If-Match"],
        });
        return options.method === "PATCH"
          ? { rev: 2 }
          : { ok: true, rev: 3 };
      },
    );

    await enqueueOutbox({
      kind: "update",
      entityId: "task-chain",
      payload: { rev: 1, patch: { title: "A" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await enqueueOutbox({
      kind: "delete",
      entityId: "task-chain",
      payload: { rev: 1 },
    });

    const result = await replayOutbox();

    expect(result).toMatchObject({
      replayed: 2,
      remaining: 0,
      conflicts: 0,
    });
    expect(calls).toEqual([
      { path: "/tasks/task-chain", method: "PATCH", ifMatch: '"rev-1"' },
      { path: "/tasks/task-chain", method: "DELETE", ifMatch: '"rev-2"' },
    ]);
    expect(db.records.size).toBe(0);
  });
});
