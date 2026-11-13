import type { Task, TaskPage } from "@/api";

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task",
    status: "open",
    allDay: false,
    listId: null,
    dueAt: null,
    dueDate: null,
    nextOccurrenceAt: null,
    nextOccurrenceLocal: null,
    rrule: null,
    ...overrides,
  };
}

export function makePage(
  tasks: Task[],
  nextCursor: string | null = null,
): TaskPage {
  return {
    tasks,
    nextCursor,
    hasMore: Boolean(nextCursor),
    source: "server",
  };
}

/** In-memory Web Storage implementation for node tests. */
export class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, String(value));
  }
}

/**
 * The event-bus modules only need `window` to be an EventTarget. This keeps
 * the suite on the node environment without pulling in a DOM implementation.
 */
export function fakeWindow(): EventTarget & {
  sessionStorage: Storage;
  localStorage: Storage;
} {
  return Object.assign(new EventTarget(), {
    sessionStorage: new MemoryStorage(),
    localStorage: new MemoryStorage(),
  });
}

export function isoAt(year: number, month: number, day: number, hour = 9, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}
