import { QueryClient, queryOptions } from "@tanstack/react-query";
import { ApiError, api, type TaskView } from "@/api";

/** Stable parameters that identify a paginated task list. */
export interface TaskListKey {
  view?: TaskView;
  listId?: string;
  tagId?: string;
  includeDone?: boolean;
}

export const queryKeys = {
  bootstrap: ["bootstrap"] as const,
  session: ["session"] as const,
  setupStatus: ["setup-status"] as const,
  tasks: ["tasks"] as const,
  taskList: (params: TaskListKey) => ["tasks", "list", params] as const,
  task: (id: string) => ["tasks", "detail", id] as const,
  search: ["search"] as const,
  searchQuery: (query: string) => ["search", query] as const,
};

/**
 * First-run guard. Deliberately short-lived: setup completes in the same tab,
 * and prepareFreshSession() clears the cache before navigating to Today.
 */
export const setupStatusQueryOptions = queryOptions({
  queryKey: queryKeys.setupStatus,
  queryFn: () => api.setupStatus(),
  staleTime: 30_000,
  gcTime: 5 * 60 * 1_000,
  retry: false,
});

export const bootstrapQueryOptions = queryOptions({
  queryKey: queryKeys.bootstrap,
  queryFn: () => api.bootstrap(),
  // Fresh enough to feel live, stale enough to be useful on a flaky connection.
  staleTime: 15_000,
  gcTime: 24 * 60 * 60 * 1_000,
  retry: (failureCount, error) => {
    if (error instanceof ApiError && error.status < 500) return false;
    return failureCount < 1;
  },
});

/** Any mutation that changes task/list state refreshes the shell + lists. */
export async function invalidateTaskQueries(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.tasks }),
    client.invalidateQueries({ queryKey: queryKeys.bootstrap }),
    client.invalidateQueries({ queryKey: queryKeys.search }),
  ]);
}

export async function invalidateBootstrap(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: queryKeys.bootstrap });
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 24 * 60 * 60 * 1_000,
        // Let the M1 view query run while offline so it can fall back to the
        // persisted bootstrap snapshot instead of pausing on a skeleton.
        networkMode: "always",
        // Replay is explicit: online/visibility handlers flush the outbox
        // BEFORE invalidating bootstrap (plan §7). Automatic reconnect
        // refetches could overwrite an unacked local change.
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status < 500) return false;
          return failureCount < 1;
        },
      },
      mutations: {
        retry: false,
        // Create/complete/snooze must execute while offline to enqueue in the
        // outbox. Edits/deletes fail explicitly with a connection error.
        networkMode: "always",
      },
    },
  });
}

/** Shared client; also used by the router guard and the persistence provider. */
export const queryClient = createQueryClient();
