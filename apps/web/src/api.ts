/**
 * Same-origin API client for Morrow (plan §5).
 *
 * All browser requests use the HttpOnly session cookie. API responses are
 * explicitly `no-store` in the browser so an authenticated GET is never
 * served from the HTTP cache. Offline reads use TanStack Query's IndexedDB
 * cache, never the service worker cache.
 *
 * M1 backend contract assumptions (the server track is parallel):
 * - GET /api/tasks?view=today|upcoming|inbox&limit=&cursor=&listId=
 *   returns `{ tasks, nextCursor }` (also accepts `{items,next}`).
 * - GET/PATCH /api/tasks/:id return the task or `{ task }`.
 * - PATCH/DELETE/snooze require `If-Match: "rev-N"`; 428 missing, 412 stale,
 *   409 semantic. A 412 body may include `current`/`task` for the resolver.
 * - POST /api/capture/parse returns the parsed title plus optional schedule
 *   fields (`dueAt`, `dueDate`, `allDay`, `rrule`, `dtstartLocal`, `listId`).
 * - POST /api/activity/undo `{activityId}` is the M3 history endpoint; until
 *   it exists the client falls back to an explicit local revert.
 */

const API_BASE = "/api";

export type WorkspaceRole = "owner" | "member";

export interface User {
  id: string;
  username?: string | null;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
  role?: WorkspaceRole | null;
  timezone?: string | null;
  createdAt?: string;
  [key: string]: unknown;
}

export interface TaskList {
  id: string;
  name?: string;
  title?: string;
  color?: string | null;
  sortKey?: string;
  isInbox?: boolean;
  shared?: boolean;
  ownerUsername?: string | null;
  rev?: number;
  taskCount?: number;
  openCount?: number;
  [key: string]: unknown;
}

export type TaskStatus = "open" | "done" | "cancelled" | string;

export interface Tag {
  id: string;
  name: string;
  color?: string | null;
  rev?: number;
  openCount?: number;
  [key: string]: unknown;
}

export interface TaskTag {
  taskId: string;
  tagId: string;
}

export interface Subtask {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  rev?: number;
  sortKey?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface Attachment {
  id: string;
  taskId: string;
  filename: string;
  mimeType: string;
  bytes: number;
  sha256?: string;
  createdAt?: string;
  url: string;
  [key: string]: unknown;
}

export type CaptureTokenKind = "capture" | "caldav";

export interface CaptureToken {
  id: string;
  name: string;
  kind?: CaptureTokenKind;
  createdAt: string;
  lastUsedAt?: string | null;
  token?: string;
  [key: string]: unknown;
}

export interface Task {
  id: string;
  title: string;
  notes?: string | null;
  status?: TaskStatus;
  listId?: string | null;
  priority?: number | string | null;
  dueAt?: string | null;
  dueDate?: string | null;
  allDay?: boolean;
  timezone?: string | null;
  remindAt?: string | null;
  reminderTimeLocal?: string | null;
  remindOffsetMinutes?: number | null;
  snoozedUntil?: string | null;
  dtstartLocal?: string | null;
  nextOccurrenceAt?: string | null;
  nextOccurrenceLocal?: string | null;
  rrule?: string | null;
  recurrenceMode?: string | null;
  recurrenceUntilUtc?: string | null;
  recurrenceUntilDate?: string | null;
  recurrenceCount?: number | null;
  occurrenceSeq?: number | null;
  clampPolicy?: string | null;
  seriesEndedAt?: string | null;
  missedCount?: number | null;
  completedAt?: string | null;
  sortKey?: string;
  createdBy?: string;
  updatedBy?: string;
  rev?: number;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  /** Present when a mutation response includes the M3 activity cursor. */
  activityId?: string | number | null;
  [key: string]: unknown;
}

export interface AppSettings {
  timezone?: string;
  theme?: string;
  notificationsEnabled?: boolean;
  aiEnabled?: boolean;
  quietHours?: {
    enabled?: boolean;
    start?: string;
    end?: string;
  } | null;
  [key: string]: unknown;
}

export interface AgentStatus {
  status?: string;
  enabled?: boolean;
  available?: boolean;
  connected?: boolean;
  model?: string | null;
  message?: string | null;
  [key: string]: unknown;
}

export interface BootstrapData {
  user?: User | null;
  settings?: AppSettings;
  lists: TaskList[];
  tasks: Task[];
  tags?: Tag[];
  taskTags?: TaskTag[];
  serverTime?: string;
  maxRev?: number;
  cursor?: number;
  vapidPublicKey?: string | null;
  agentStatus?: AgentStatus | null;
  agent?: AgentStatus | null;
}

export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  traceId?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly traceId: string | undefined;
  readonly problem: ProblemDetails | null;
  /** Strong ETag returned with a conflict (usually `"rev-N"`). */
  readonly etag: string | undefined;
  /** Current server representation attached to 409/412, when provided. */
  readonly current: Task | null;

  constructor(
    status: number,
    problem: ProblemDetails | null,
    fallback: string,
    options: { etag?: string; current?: Task | null } = {},
  ) {
    super(problem?.detail || problem?.title || fallback);
    this.name = "ApiError";
    this.status = status;
    this.code = problem?.code;
    this.detail = problem?.detail;
    this.traceId = problem?.traceId;
    this.problem = problem;
    this.etag = options.etag;
    this.current = options.current ?? currentTaskFromProblem(problem);
  }
}

interface ApiFetchOptions extends Omit<RequestInit, "body" | "headers"> {
  body?: unknown;
  headers?: Record<string, string>;
  /** Auth endpoints must never trigger the global session-expired redirect. */
  suppressAuthEvent?: boolean;
}

let sessionExpiredDispatched = false;

function dispatchSessionExpired(): void {
  if (sessionExpiredDispatched) return;
  sessionExpiredDispatched = true;
  window.dispatchEvent(new Event("morrow:session-expired"));
  // Allow a subsequent login to surface a new expiry.
  window.setTimeout(() => {
    sessionExpiredDispatched = false;
  }, 5_000);
}

async function readProblem(response: Response): Promise<ProblemDetails | null> {
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      return (await response.json()) as ProblemDetails;
    }
    const text = await response.text();
    return text ? { title: response.statusText, detail: text.slice(0, 500) } : null;
  } catch {
    return null;
  }
}

export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const { body, headers, suppressAuthEvent, ...init } = options;
  const requestHeaders: Record<string, string> = {
    Accept: "application/json",
    ...headers,
  };

  let requestBody: BodyInit | undefined;
  if (body !== undefined && body !== null) {
    if (body instanceof FormData || typeof body === "string") {
      requestBody = body;
    } else {
      requestHeaders["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      body: requestBody,
      headers: requestHeaders,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new TypeError("Can't reach Morrow. Check the server and try again.", {
      cause: error,
    });
  }

  if (!response.ok) {
    const problem = await readProblem(response);
    if (response.status === 401 && !suppressAuthEvent) {
      dispatchSessionExpired();
    }
    throw new ApiError(
      response.status,
      problem,
      `Request failed with status ${response.status}.`,
      { etag: response.headers.get("etag") ?? undefined },
    );
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) return (await response.json()) as T;
  return (await response.text()) as T;
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

function pick<T>(
  row: Record<string, unknown>,
  ...keys: string[]
): T | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null) return value as T;
  }
  return undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function boolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function unwrapRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const row = raw as Record<string, unknown>;
  // Accept `{data: {...}}` envelopes, but do not mistake a task's own `data`
  // field for an envelope.
  const nested = row["data"];
  if (
    nested &&
    typeof nested === "object" &&
    !Array.isArray(nested) &&
    !("id" in row) &&
    !("task" in row)
  ) {
    return nested as Record<string, unknown>;
  }
  return row;
}

export function normalizeTag(raw: unknown): Tag {
  const row = unwrapRecord(raw);
  return {
    ...row,
    id: String(row["id"] ?? ""),
    name: String(row["name"] ?? ""),
    color: typeof row["color"] === "string" ? row["color"] : null,
    rev: numeric(pick<unknown>(row, "rev")),
    openCount:
      numeric(pick<unknown>(row, "openCount", "open_count")) ?? 0,
  };
}

export function normalizeSubtask(raw: unknown): Subtask {
  const row = unwrapRecord(raw);
  return {
    ...row,
    id: String(row["id"] ?? ""),
    taskId: String(row["taskId"] ?? row["task_id"] ?? ""),
    title: String(row["title"] ?? ""),
    done: boolean(pick<unknown>(row, "done")),
    rev: numeric(pick<unknown>(row, "rev")),
    sortKey: pick<string>(row, "sortKey", "sort_key"),
    createdAt: pick<string>(row, "createdAt", "created_at"),
    updatedAt: pick<string>(row, "updatedAt", "updated_at"),
  };
}

export function normalizeAttachment(raw: unknown): Attachment {
  const row = unwrapRecord(raw);
  const id = String(row["id"] ?? "");
  return {
    ...row,
    id,
    taskId: String(row["taskId"] ?? row["task_id"] ?? ""),
    filename: String(row["filename"] ?? "attachment"),
    mimeType: String(row["mimeType"] ?? row["mime_type"] ?? "application/octet-stream"),
    bytes: numeric(pick<unknown>(row, "bytes")) ?? 0,
    sha256: pick<string>(row, "sha256") ?? undefined,
    createdAt: pick<string>(row, "createdAt", "created_at") ?? undefined,
    url:
      pick<string>(row, "url") ??
      `/api/attachments/${encodeURIComponent(id)}/download`,
  };
}

export function normalizeList(raw: unknown): TaskList {
  const row = unwrapRecord(raw);
  return {
    ...row,
    id: String(row["id"] ?? ""),
    name:
      typeof row["name"] === "string"
        ? row["name"]
        : typeof row["title"] === "string"
          ? row["title"]
          : undefined,
    color: typeof row["color"] === "string" ? row["color"] : null,
    sortKey: pick<string>(row, "sortKey", "sort_key"),
    rev: numeric(pick<unknown>(row, "rev")),
    isInbox: boolean(pick<unknown>(row, "isInbox", "is_inbox")),
    shared: boolean(pick<unknown>(row, "shared")),
    ownerUsername:
      pick<string>(row, "ownerUsername", "owner_username") ?? null,
  };
}

/** DB rows are snake_case; the browser speaks camelCase (plan §3). */
export function normalizeTask(raw: unknown): Task {
  const row = unwrapRecord(raw);
  const allDay = pick<unknown>(row, "allDay", "all_day");
  return {
    ...row,
    id: String(row["id"] ?? ""),
    title: String(row["title"] ?? ""),
    notes: pick<string>(row, "notes") ?? null,
    status: pick<string>(row, "status"),
    listId: pick<string>(row, "listId", "list_id") ?? null,
    priority: pick<number | string>(row, "priority") ?? null,
    dueAt: pick<string>(row, "dueAt", "due_at") ?? null,
    dueDate: pick<string>(row, "dueDate", "due_date") ?? null,
    allDay: boolean(allDay),
    timezone: pick<string>(row, "timezone") ?? null,
    remindAt: pick<string>(row, "remindAt", "remind_at") ?? null,
    reminderTimeLocal:
      pick<string>(row, "reminderTimeLocal", "reminder_time_local") ?? null,
    remindOffsetMinutes:
      numeric(pick<unknown>(row, "remindOffsetMinutes", "remind_offset_minutes")) ??
      null,
    snoozedUntil: pick<string>(row, "snoozedUntil", "snoozed_until") ?? null,
    dtstartLocal: pick<string>(row, "dtstartLocal", "dtstart_local") ?? null,
    nextOccurrenceAt:
      pick<string>(row, "nextOccurrenceAt", "next_occurrence_at") ?? null,
    nextOccurrenceLocal:
      pick<string>(row, "nextOccurrenceLocal", "next_occurrence_local") ?? null,
    rrule: pick<string>(row, "rrule") ?? null,
    recurrenceMode:
      pick<string>(row, "recurrenceMode", "recurrence_mode") ?? null,
    recurrenceUntilUtc:
      pick<string>(row, "recurrenceUntilUtc", "recurrence_until_utc") ?? null,
    recurrenceUntilDate:
      pick<string>(row, "recurrenceUntilDate", "recurrence_until_date") ?? null,
    recurrenceCount:
      numeric(pick<unknown>(row, "recurrenceCount", "recurrence_count")) ?? null,
    occurrenceSeq:
      numeric(pick<unknown>(row, "occurrenceSeq", "occurrence_seq")) ?? null,
    clampPolicy: pick<string>(row, "clampPolicy", "clamp_policy") ?? null,
    seriesEndedAt:
      pick<string>(row, "seriesEndedAt", "series_ended_at") ?? null,
    missedCount:
      numeric(pick<unknown>(row, "missedCount", "missed_count")) ?? null,
    completedAt: pick<string>(row, "completedAt", "completed_at") ?? null,
    sortKey: pick<string>(row, "sortKey", "sort_key"),
    createdBy: pick<string>(row, "createdBy", "created_by"),
    updatedBy: pick<string>(row, "updatedBy", "updated_by"),
    rev: numeric(pick<unknown>(row, "rev")),
    createdAt: pick<string>(row, "createdAt", "created_at"),
    updatedAt: pick<string>(row, "updatedAt", "updated_at"),
    deletedAt: pick<string>(row, "deletedAt", "deleted_at") ?? null,
  };
}

function currentTaskFromProblem(problem: ProblemDetails | null): Task | null {
  if (!problem) return null;
  const direct = problem["current"] ?? problem["task"];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return normalizeTask(direct);
  }
  const data = problem["data"];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const nested = record["current"] ?? record["task"];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return normalizeTask(nested);
    }
  }
  return null;
}

function normalizeTaskResponse(raw: unknown): Task {
  const row = unwrapRecord(raw);
  const candidate = row["task"] ?? row["data"] ?? row;
  const task = normalizeTask(candidate);
  const activityId =
    row["activityId"] ??
    row["activity_id"] ??
    (row["activity"] as Record<string, unknown> | undefined)?.["id"] ??
    (row["activity"] as Record<string, unknown> | undefined)?.["seq"];
  if (activityId !== undefined && activityId !== null) {
    task.activityId = typeof activityId === "number" ? activityId : String(activityId);
  }
  return task;
}

function normalizeNextCursor(row: Record<string, unknown>): string | null {
  const raw =
    row["nextCursor"] ??
    row["next_cursor"] ??
    row["next"] ??
    row["cursor"] ??
    null;
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

export interface TaskPage {
  tasks: Task[];
  nextCursor: string | null;
  hasMore: boolean;
  /** `bootstrap` means the M1 list route was not available (M0 fallback). */
  source: "server" | "bootstrap";
}

export function normalizeTaskPage(raw: unknown): TaskPage {
  const payload = unwrapRecord(raw);
  const arrayCandidate = Array.isArray(raw)
    ? raw
    : Array.isArray(payload["tasks"])
      ? payload["tasks"]
      : Array.isArray(payload["items"])
        ? payload["items"]
        : Array.isArray(payload["results"])
          ? payload["results"]
          : Array.isArray(payload["data"])
            ? payload["data"]
            : [];
  const tasks = arrayCandidate.map(normalizeTask);
  const nextCursor = normalizeNextCursor(payload);
  const explicitHasMore =
    typeof payload["hasMore"] === "boolean"
      ? payload["hasMore"]
      : typeof payload["has_more"] === "boolean"
        ? payload["has_more"]
        : undefined;
  return {
    tasks,
    nextCursor,
    hasMore: explicitHasMore ?? Boolean(nextCursor),
    source: "server",
  };
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

export interface SetupInput {
  /** Only required when the instance runs with SETUP_MODE=token. */
  token?: string;
  password: string;
  timezone: string;
}

export interface LoginInput {
  username?: string;
  password: string;
}

export const api = {
  /** Public first-run probe; safe before any session exists. */
  setupStatus(): Promise<{
    setupRequired: boolean;
    tokenRequired: boolean;
  }> {
    return apiFetch("/setup/status", {
      method: "GET",
      suppressAuthEvent: true,
    });
  },

  setup(input: SetupInput): Promise<unknown> {
    return apiFetch("/setup", {
      method: "POST",
      body: input,
      suppressAuthEvent: true,
    });
  },

  login(input: LoginInput): Promise<unknown> {
    return apiFetch("/login", {
      method: "POST",
      body: input,
      suppressAuthEvent: true,
    });
  },

  logout(): Promise<void> {
    return apiFetch("/logout", {
      method: "POST",
      suppressAuthEvent: true,
    });
  },

  session(): Promise<{ user?: User | null }> {
    return apiFetch("/auth/session", {
      method: "GET",
      suppressAuthEvent: true,
    });
  },

  async bootstrap(): Promise<BootstrapData> {
    const raw = await apiFetch<Record<string, unknown>>("/bootstrap", {
      method: "GET",
    });
    // Accept both the direct bootstrap envelope and a `{ data }` wrapper so
    // the shell survives small server-side response-shape changes.
    const payload = (raw["data"] && !raw["tasks"] ? raw["data"] : raw) as Record<
      string,
      unknown
    >;
    const listsRaw = Array.isArray(payload["lists"]) ? payload["lists"] : [];
    const tasksRaw = Array.isArray(payload["tasks"]) ? payload["tasks"] : [];
    const normalizedLists = listsRaw.map(normalizeList);
    // The M0 server seeds a literal "Inbox" list. In the product, Inbox is a
    // smart view, not a list; hide that seed (and normalise its tasks) until M1
    // owns list/inbox semantics. A colored list explicitly named Inbox stays.
    const implicitInboxIds = new Set(
      normalizedLists
        .filter(
          (list) =>
            list.isInbox ||
            ((list.name || list.title || "").toLowerCase() === "inbox" &&
              !list.color),
        )
        .map((list) => list.id),
    );
    return {
      user: (payload["user"] as User | null | undefined) ?? null,
      settings: (payload["settings"] as AppSettings | undefined) ?? {},
      lists: normalizedLists.filter((list) => !implicitInboxIds.has(list.id)),
      tasks: tasksRaw.map(normalizeTask).map((task) =>
        task.listId && implicitInboxIds.has(task.listId)
          ? { ...task, listId: null }
          : task,
      ),
      tags: (Array.isArray(payload["tags"]) ? payload["tags"] : []).map(
        normalizeTag,
      ),
      taskTags: (Array.isArray(payload["taskTags"])
        ? payload["taskTags"]
        : []
      ).map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          taskId: String(row["taskId"] ?? row["task_id"] ?? ""),
          tagId: String(row["tagId"] ?? row["tag_id"] ?? ""),
        } satisfies TaskTag;
      }),
      serverTime:
        typeof payload["serverTime"] === "string"
          ? payload["serverTime"]
          : undefined,
      maxRev:
        typeof payload["maxRev"] === "number" ? payload["maxRev"] : undefined,
      cursor:
        typeof payload["cursor"] === "number" ? payload["cursor"] : undefined,
      vapidPublicKey:
        typeof payload["vapidPublicKey"] === "string"
          ? payload["vapidPublicKey"]
          : null,
      agentStatus: (payload["agentStatus"] ??
        payload["agent"] ??
        null) as AgentStatus | null,
      agent: (payload["agent"] ?? null) as AgentStatus | null,
    };
  },

  updateSettings(patch: Record<string, unknown>): Promise<{ settings: AppSettings }> {
    return apiFetch("/settings", { method: "PATCH", body: patch });
  },
};

/* -------------------------------------------------------------------------- */
/* Lists                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateListInput {
  id: string;
  name: string;
  color?: string;
}

export interface UpdateListInput {
  name?: string;
  color?: string | null;
}

export const listApi = {
  async create(input: CreateListInput): Promise<TaskList> {
    const raw = await apiFetch<unknown>("/lists", {
      method: "POST",
      body: input,
      headers: { "Idempotency-Key": input.id },
    });
    const row = unwrapRecord(raw);
    return normalizeList(row["list"] ?? row["data"] ?? row);
  },

  async update(list: TaskList, patch: UpdateListInput): Promise<TaskList> {
    const raw = await apiFetch<unknown>(
      `/lists/${encodeURIComponent(list.id)}`,
      {
        method: "PATCH",
        body: patch,
        headers: ifMatchHeaders(list.rev),
      },
    );
    const row = unwrapRecord(raw);
    return normalizeList(row["list"] ?? row["data"] ?? row);
  },

  remove(list: TaskList): Promise<void> {
    return apiFetch(`/lists/${encodeURIComponent(list.id)}`, {
      method: "DELETE",
      headers: ifMatchHeaders(list.rev),
    });
  },

  async members(
    listId: string,
  ): Promise<Array<{ id: string; username: string; timezone: string; role: string }>> {
    const raw = await apiFetch<{ members?: unknown[] }>(
      `/lists/${encodeURIComponent(listId)}/members`,
    );
    return (Array.isArray(raw.members) ? raw.members : []).map((entry) => {
      const row = entry as Record<string, unknown>;
      return {
        id: String(row["id"] ?? ""),
        username: String(row["username"] ?? ""),
        timezone: String(row["timezone"] ?? "UTC"),
        role: String(row["role"] ?? "member"),
      };
    });
  },

  share(listId: string, username: string): Promise<unknown> {
    return apiFetch(`/lists/${encodeURIComponent(listId)}/share`, {
      method: "POST",
      body: { username },
    });
  },

  unshare(listId: string, userId: string): Promise<void> {
    return apiFetch(
      `/lists/${encodeURIComponent(listId)}/share/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  },
};

/* -------------------------------------------------------------------------- */
/* Tasks                                                                      */
/* -------------------------------------------------------------------------- */

export type TaskView = "today" | "upcoming" | "inbox";

export interface TaskQueryInput {
  view?: TaskView;
  listId?: string;
  tagId?: string;
  limit?: number;
  cursor?: string | null;
  includeDone?: boolean;
  signal?: AbortSignal;
}

export interface CreateTaskInput {
  id: string;
  title: string;
  listId?: string | null;
  notes?: string | null;
  dueAt?: string | null;
  dueDate?: string | null;
  allDay?: boolean;
  timezone?: string | null;
  priority?: number | null;
  remindAt?: string | null;
  reminderTimeLocal?: string | null;
  remindOffsetMinutes?: number | null;
  rrule?: string | null;
  dtstartLocal?: string | null;
  recurrenceMode?: string | null;
  recurrenceUntilUtc?: string | null;
  recurrenceUntilDate?: string | null;
  recurrenceCount?: number | null;
}

export interface UpdateTaskInput {
  title?: string;
  notes?: string | null;
  status?: TaskStatus;
  priority?: number | null;
  listId?: string | null;
  dueAt?: string | null;
  dueDate?: string | null;
  allDay?: boolean;
  timezone?: string | null;
  remindAt?: string | null;
  reminderTimeLocal?: string | null;
  remindOffsetMinutes?: number | null;
  snoozedUntil?: string | null;
  dtstartLocal?: string | null;
  nextOccurrenceAt?: string | null;
  nextOccurrenceLocal?: string | null;
  occurrenceSeq?: number;
  rrule?: string | null;
  recurrenceMode?: string | null;
  recurrenceUntilUtc?: string | null;
  recurrenceUntilDate?: string | null;
  recurrenceCount?: number | null;
  completedAt?: string | null;
  sortKey?: string;
}

function taskPath(id: string, suffix = ""): string {
  return `/tasks/${encodeURIComponent(id)}${suffix}`;
}

export const taskApi = {
  async list(input: TaskQueryInput = {}): Promise<TaskPage> {
    const params = new URLSearchParams();
    if (input.view) params.set("view", input.view);
    if (input.listId) params.set("listId", input.listId);
    if (input.tagId) params.set("tagId", input.tagId);
    if (input.limit) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);
    if (input.includeDone) params.set("includeDone", "1");
    const query = params.toString();
    const raw = await apiFetch<unknown>(`/tasks${query ? `?${query}` : ""}`, {
      signal: input.signal,
    });
    return normalizeTaskPage(raw);
  },

  async create(input: CreateTaskInput): Promise<Task> {
    const raw = await apiFetch<unknown>("/tasks", {
      method: "POST",
      body: input,
      headers: { "Idempotency-Key": input.id },
    });
    return normalizeTaskResponse(raw);
  },

  async get(id: string, signal?: AbortSignal): Promise<Task> {
    const raw = await apiFetch<unknown>(taskPath(id), { signal });
    return normalizeTaskResponse(raw);
  },

  async update(task: Task, patch: UpdateTaskInput): Promise<Task> {
    const raw = await apiFetch<unknown>(taskPath(task.id), {
      method: "PATCH",
      body: patch,
      headers: ifMatchHeaders(task.rev),
    });
    return normalizeTaskResponse(raw);
  },

  remove(task: Task): Promise<void> {
    return apiFetch(taskPath(task.id), {
      method: "DELETE",
      headers: ifMatchHeaders(task.rev),
    });
  },

  async complete(task: Task, occurrenceKey?: string): Promise<Task> {
    const raw = await apiFetch<unknown>(taskPath(task.id, "/complete"), {
      method: "POST",
      body: occurrenceKey ? { occurrenceKey } : {},
      headers: ifMatchHeaders(task.rev),
    });
    return normalizeTaskResponse(raw);
  },

  async snooze(task: Task, until: string): Promise<Task> {
    const raw = await apiFetch<unknown>(taskPath(task.id, "/snooze"), {
      method: "POST",
      body: { until },
      headers: ifMatchHeaders(task.rev),
    });
    return normalizeTaskResponse(raw);
  },

  async skip(task: Task, occurrenceKey?: string): Promise<Task> {
    const raw = await apiFetch<unknown>(taskPath(task.id, "/skip"), {
      method: "POST",
      body: occurrenceKey ? { occurrenceKey } : {},
      headers: ifMatchHeaders(task.rev),
    });
    return normalizeTaskResponse(raw);
  },

  async search(
    query: string,
    options: { signal?: AbortSignal; cursor?: string | null; limit?: number } = {},
  ): Promise<TaskPage> {
    const params = new URLSearchParams({ q: query });
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit) params.set("limit", String(options.limit));
    const raw = await apiFetch<unknown>(`/search?${params.toString()}`, {
      signal: options.signal,
    });
    return normalizeTaskPage(raw);
  },
};

/* -------------------------------------------------------------------------- */
/* Tags, subtasks, attachments, capture tokens                                */
/* -------------------------------------------------------------------------- */

export const tagApi = {
  async list(): Promise<Tag[]> {
    const raw = await apiFetch<{ tags?: unknown[] }>("/tags");
    return (Array.isArray(raw.tags) ? raw.tags : []).map(normalizeTag);
  },

  async create(input: { id?: string; name: string; color?: string | null }): Promise<Tag> {
    const raw = await apiFetch<unknown>("/tags", {
      method: "POST",
      body: input,
    });
    return normalizeTag(raw);
  },

  async update(tag: Tag, patch: { name?: string; color?: string | null }): Promise<Tag> {
    const raw = await apiFetch<unknown>(`/tags/${encodeURIComponent(tag.id)}`, {
      method: "PATCH",
      body: patch,
      headers: ifMatchHeaders(tag.rev),
    });
    return normalizeTag(raw);
  },

  remove(tag: Tag): Promise<void> {
    return apiFetch(`/tags/${encodeURIComponent(tag.id)}`, {
      method: "DELETE",
      headers: ifMatchHeaders(tag.rev),
    });
  },

  async forTask(taskId: string): Promise<Tag[]> {
    const raw = await apiFetch<{ tags?: unknown[] }>(
      `/tasks/${encodeURIComponent(taskId)}/tags`,
    );
    return (Array.isArray(raw.tags) ? raw.tags : []).map(normalizeTag);
  },

  async setForTask(taskId: string, tagIds: string[]): Promise<Tag[]> {
    const raw = await apiFetch<{ tags?: unknown[] }>(
      `/tasks/${encodeURIComponent(taskId)}/tags`,
      { method: "PUT", body: { tagIds } },
    );
    return (Array.isArray(raw.tags) ? raw.tags : []).map(normalizeTag);
  },
};

export const subtaskApi = {
  async list(taskId: string): Promise<Subtask[]> {
    const raw = await apiFetch<{ subtasks?: unknown[] }>(
      `/tasks/${encodeURIComponent(taskId)}/subtasks`,
    );
    return (Array.isArray(raw.subtasks) ? raw.subtasks : []).map(normalizeSubtask);
  },

  async create(taskId: string, input: { id?: string; title: string; done?: boolean }): Promise<Subtask> {
    const raw = await apiFetch<unknown>(
      `/tasks/${encodeURIComponent(taskId)}/subtasks`,
      { method: "POST", body: input },
    );
    return normalizeSubtask(raw);
  },

  async update(subtask: Subtask, patch: { title?: string; done?: boolean }): Promise<Subtask> {
    const raw = await apiFetch<unknown>(
      `/subtasks/${encodeURIComponent(subtask.id)}`,
      { method: "PATCH", body: patch },
    );
    return normalizeSubtask(raw);
  },

  remove(subtask: Subtask): Promise<void> {
    return apiFetch(`/subtasks/${encodeURIComponent(subtask.id)}`, {
      method: "DELETE",
    });
  },
};

export const attachmentApi = {
  async list(taskId: string): Promise<Attachment[]> {
    const raw = await apiFetch<{ attachments?: unknown[] }>(
      `/tasks/${encodeURIComponent(taskId)}/attachments`,
    );
    return (Array.isArray(raw.attachments) ? raw.attachments : []).map(
      normalizeAttachment,
    );
  },

  async upload(taskId: string, file: File): Promise<Attachment> {
    const form = new FormData();
    form.append("file", file, file.name);
    const raw = await apiFetch<unknown>(
      `/tasks/${encodeURIComponent(taskId)}/attachments`,
      { method: "POST", body: form },
    );
    return normalizeAttachment(raw);
  },

  remove(attachment: Attachment): Promise<void> {
    return apiFetch(`/attachments/${encodeURIComponent(attachment.id)}`, {
      method: "DELETE",
    });
  },
};

export const captureTokenApi = {
  async list(): Promise<CaptureToken[]> {
    const raw = await apiFetch<{ tokens?: unknown[] }>("/capture/tokens");
    return (Array.isArray(raw.tokens) ? raw.tokens : []).map((entry) => {
      const row = entry as Record<string, unknown>;
      return {
        ...row,
        id: String(row["id"] ?? ""),
        name: String(row["name"] ?? ""),
        kind: row["kind"] === "caldav" ? "caldav" : "capture",
        createdAt: String(row["createdAt"] ?? row["created_at"] ?? ""),
        lastUsedAt:
          (row["lastUsedAt"] as string | null | undefined) ??
          (row["last_used_at"] as string | null | undefined) ??
          null,
      };
    });
  },

  async create(
    name: string,
    kind: CaptureTokenKind = "capture",
  ): Promise<CaptureToken> {
    const raw = await apiFetch<Record<string, unknown>>("/capture/tokens", {
      method: "POST",
      body: { name, kind },
    });
    return {
      ...raw,
      id: String(raw["id"] ?? ""),
      name: String(raw["name"] ?? name),
      kind: raw["kind"] === "caldav" ? "caldav" : "capture",
      createdAt: String(raw["createdAt"] ?? ""),
      lastUsedAt: (raw["lastUsedAt"] as string | null | undefined) ?? null,
      token: typeof raw["token"] === "string" ? raw["token"] : undefined,
    };
  },

  revoke(id: string): Promise<void> {
    return apiFetch(`/capture/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
};

/* -------------------------------------------------------------------------- */
/* Capture, history, push, backup                                             */
/* -------------------------------------------------------------------------- */

export interface ParsedCapture {
  title: string;
  dueAt?: string | null;
  dueDate?: string | null;
  allDay?: boolean;
  listId?: string | null;
  listName?: string | null;
  remindAt?: string | null;
  reminderTimeLocal?: string | null;
  remindOffsetMinutes?: number | null;
  rrule?: string | null;
  dtstartLocal?: string | null;
  timezone?: string | null;
  confidence?: number | null;
  source?: string | null;
  [key: string]: unknown;
}

export const captureApi = {
  async parse(
    text: string,
    timezone: string,
    signal?: AbortSignal,
    options: { ai?: boolean } = {},
  ): Promise<ParsedCapture> {
    const raw = await apiFetch<unknown>("/capture/parse", {
      method: "POST",
      body: { text, timezone, ...(options.ai ? { mode: "auto" } : {}) },
      signal,
    });
    const row = unwrapRecord(raw);
    const candidate =
      row["parsed"] ?? row["capture"] ?? row["result"] ?? row["data"] ?? row;
    const parsed = unwrapRecord(candidate);
    const allDay = parsed["allDay"] ?? parsed["all_day"];
    return {
      ...parsed,
      title: String(parsed["title"] ?? text),
      dueAt: pick<string>(parsed, "dueAt", "due_at") ?? null,
      dueDate: pick<string>(parsed, "dueDate", "due_date") ?? null,
      allDay: boolean(allDay),
      listId: pick<string>(parsed, "listId", "list_id") ?? null,
      listName: pick<string>(parsed, "listName", "list_name") ?? null,
      remindAt: pick<string>(parsed, "remindAt", "remind_at") ?? null,
      reminderTimeLocal:
        pick<string>(parsed, "reminderTimeLocal", "reminder_time_local") ?? null,
      remindOffsetMinutes:
        numeric(
          pick<unknown>(parsed, "remindOffsetMinutes", "remind_offset_minutes"),
        ) ?? null,
      rrule: pick<string>(parsed, "rrule") ?? null,
      dtstartLocal:
        pick<string>(parsed, "dtstartLocal", "dtstart_local") ?? null,
      timezone: pick<string>(parsed, "timezone") ?? null,
      confidence: numeric(parsed["confidence"]) ?? null,
      source: pick<string>(parsed, "source", "parser") ?? null,
    };
  },
};

export const activityApi = {
  /** M3 history/undo endpoint: `POST /api/activity/:seq/undo`. */
  undo(activityId: string | number): Promise<unknown> {
    return apiFetch(`/activity/${encodeURIComponent(String(activityId))}/undo`, {
      method: "POST",
    });
  },

  /**
   * Find the most recent activity row for an entity/action, then undo it.
   * Mutation responses don't carry the activity seq, so Cmd+Z asks the
   * history endpoint rather than guessing from a local snapshot. Returns the
   * undone seq, or null when this server has no matching history row.
   */
  async undoLatest(options: {
    entityId: string;
    action: string;
    fromCursor?: number;
  }): Promise<number | null> {
    const from =
      options.fromCursor !== undefined && options.fromCursor > 0
        ? options.fromCursor
        : null;
    const raw = await apiFetch<{ activities?: Array<Record<string, unknown>> }>(
      `/activity?order=desc&limit=200${from ? `&cursor=${from}` : ""}`,
    );
    const rows = Array.isArray(raw.activities) ? raw.activities : [];
    const matches = rows
      .filter(
        (row) =>
          row["entityId"] === options.entityId &&
          row["action"] === options.action &&
          typeof row["seq"] === "number",
      )
      .sort((a, b) => Number(b["seq"]) - Number(a["seq"]));
    const latest = matches[0];
    if (!latest) return null;
    const seq = Number(latest["seq"]);
    // If the newest matching action has already been undone, do not send a
    // second undo for it (the server would 409 and the stack would stick).
    const latestUndoSeq = rows
      .filter(
        (row) =>
          row["entityId"] === options.entityId &&
          row["action"] === `${options.action}.undo` &&
          typeof row["seq"] === "number",
      )
      .reduce((max, row) => Math.max(max, Number(row["seq"])), 0);
    if (latestUndoSeq > seq) return null;
    await apiFetch(`/activity/${seq}/undo`, { method: "POST" });
    return seq;
  },
};

export const ntfyApi = {
  test(): Promise<{ ok?: boolean; statusCode?: number | null; error?: string | null }> {
    return apiFetch("/ntfy/test", { method: "POST" });
  },
};

export const pushApi = {
  vapidPublicKey(): Promise<{ publicKey?: string; key?: string }> {
    return apiFetch("/push/vapid-public-key");
  },

  subscribe(subscription: PushSubscriptionJSON): Promise<void> {
    return apiFetch("/push/subscriptions", {
      method: "POST",
      body: { subscription },
    });
  },

  unsubscribe(endpoint: string): Promise<void> {
    return apiFetch("/push/subscriptions", {
      method: "DELETE",
      body: { endpoint },
    });
  },

  test(): Promise<{
    ok?: boolean;
    sent?: number;
    failed?: number;
    disabled?: number;
  }> {
    return apiFetch("/push/test", { method: "POST" });
  },
};

export const trashApi = {
  /** GET /api/trash → `{ tasks, lists }` (snake_case rows; normalized here). */
  async list(): Promise<{ tasks: Task[]; lists: TaskList[] }> {
    const raw = await apiFetch<Record<string, unknown>>("/trash");
    const tasksRaw = Array.isArray(raw["tasks"]) ? raw["tasks"] : [];
    const listsRaw = Array.isArray(raw["lists"]) ? raw["lists"] : [];
    return {
      tasks: (tasksRaw as unknown[]).map(normalizeTask),
      lists: (listsRaw as unknown[]).map(normalizeList),
    };
  },

  /** POST /api/trash/tasks/:id/restore — rev bumps server-side. */
  async restoreTask(id: string): Promise<Task> {
    const raw = await apiFetch<unknown>(
      `/trash/tasks/${encodeURIComponent(id)}/restore`,
      { method: "POST" },
    );
    const row = unwrapRecord(raw);
    return normalizeTask(row["task"] ?? row);
  },

  /** POST /api/trash/lists/:id/restore — rev bumps server-side. */
  async restoreList(id: string): Promise<TaskList> {
    const raw = await apiFetch<unknown>(
      `/trash/lists/${encodeURIComponent(id)}/restore`,
      { method: "POST" },
    );
    const row = unwrapRecord(raw);
    return normalizeList(row["list"] ?? row);
  },

  /** DELETE /api/trash/tasks/:id — requires fresh step-up (403 otherwise). */
  purgeTask(id: string): Promise<{ ok?: boolean }> {
    return apiFetch(`/trash/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  /** DELETE /api/trash/lists/:id — requires fresh step-up (403 otherwise). */
  purgeList(id: string): Promise<{ ok?: boolean }> {
    return apiFetch(`/trash/lists/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
};

export interface LedgerData {
  taskId: string;
  nextOccurrenceAt: string | null;
  nextOccurrenceLocal: string | null;
  /** Number of enabled push devices for this account. */
  devices: number;
  /** ISO timestamp of the most recent delivery attempt, if any. */
  lastSent: string | null;
  /** Latest delivery status (`sent`, `failed`, `pending`, … or null). */
  lastStatus: string | null;
}

export const ledgerApi = {
  /** GET /api/tasks/:id/ledger — §9 one-liner backing data. */
  async get(taskId: string): Promise<LedgerData> {
    const raw = await apiFetch<Record<string, unknown>>(
      `/tasks/${encodeURIComponent(taskId)}/ledger`,
    );
    const devicesRaw =
      raw["devices"] ?? raw["deviceCount"] ?? raw["device_count"];
    return {
      taskId: String(raw["taskId"] ?? raw["task_id"] ?? taskId),
      nextOccurrenceAt:
        (raw["next_occurrence_at"] as string | null | undefined) ??
        (raw["nextOccurrenceAt"] as string | null | undefined) ??
        null,
      nextOccurrenceLocal:
        (raw["next_occurrence_local"] as string | null | undefined) ??
        (raw["nextOccurrenceLocal"] as string | null | undefined) ??
        null,
      devices:
        typeof devicesRaw === "number" && Number.isFinite(devicesRaw)
          ? devicesRaw
          : 0,
      lastSent:
        (raw["last_sent"] as string | null | undefined) ??
        (raw["lastSent"] as string | null | undefined) ??
        null,
      lastStatus:
        (raw["last_status"] as string | null | undefined) ??
        (raw["lastStatus"] as string | null | undefined) ??
        null,
    };
  },
};

export const authApi = {
  /** POST /api/auth/password — fresh step-up stamp for purge/restore. */
  stepUp(password: string): Promise<{ ok?: boolean; stepUpAt?: string }> {
    return apiFetch("/auth/password", {
      method: "POST",
      body: { password },
    });
  },

  changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok?: boolean; revokedSessions?: number }> {
    return apiFetch("/auth/change-password", {
      method: "POST",
      body: { currentPassword, newPassword },
    });
  },

  async sessions(): Promise<
    Array<{
      id: string;
      createdAt: string;
      lastSeenAt: string;
      expiresAt: string;
      ip?: string | null;
      userAgent?: string | null;
      current: boolean;
    }>
  > {
    const raw = await apiFetch<{ sessions?: unknown[] }>("/auth/sessions");
    return (Array.isArray(raw.sessions) ? raw.sessions : []).map((entry) => {
      const row = entry as Record<string, unknown>;
      return {
        id: String(row["id"] ?? ""),
        createdAt: String(row["createdAt"] ?? ""),
        lastSeenAt: String(row["lastSeenAt"] ?? ""),
        expiresAt: String(row["expiresAt"] ?? ""),
        ip: (row["ip"] as string | null | undefined) ?? null,
        userAgent: (row["userAgent"] as string | null | undefined) ?? null,
        current: row["current"] === true,
      };
    });
  },

  revokeSession(id: string): Promise<void> {
    return apiFetch(`/auth/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
};

export interface UserAccount {
  id: string;
  username: string;
  role: WorkspaceRole;
  timezone: string;
  createdAt: string;
  current: boolean;
}

export const userApi = {
  /** PATCH /api/me — self-service per-account timezone. */
  updateTimezone(timezone: string): Promise<{ user?: unknown }> {
    return apiFetch("/me", { method: "PATCH", body: { timezone } });
  },

  async list(): Promise<UserAccount[]> {
    const raw = await apiFetch<{ users?: unknown[] }>("/users");
    return (Array.isArray(raw.users) ? raw.users : []).map((entry) => {
      const row = entry as Record<string, unknown>;
      return {
        id: String(row["id"] ?? ""),
        username: String(row["username"] ?? ""),
        role: row["role"] === "owner" ? "owner" : "member",
        timezone: String(row["timezone"] ?? "UTC"),
        createdAt: String(row["createdAt"] ?? row["created_at"] ?? ""),
        current: row["current"] === true,
      };
    });
  },

  create(input: {
    username: string;
    password: string;
    timezone: string;
  }): Promise<{ user?: unknown; note?: string }> {
    return apiFetch("/users", { method: "POST", body: input });
  },
};

export const backupApi = {
  run(): Promise<unknown> {
    return apiFetch("/backup/run", { method: "POST" });
  },

  runs(): Promise<{
    runs: Array<{
      id: string;
      name: string;
      createdAt: string;
      status: string;
      bytes?: number | null;
      fileExists?: boolean;
    }>;
  }> {
    return apiFetch("/backup/runs");
  },

  exportUrl(): string {
    return `${API_BASE}/backup/export`;
  },

  async import(
    file: File,
    options: { dryRun?: boolean; confirm?: string },
  ): Promise<{
    dryRun: boolean;
    counts: Record<string, number>;
    diff?: unknown;
    [key: string]: unknown;
  }> {
    const form = new FormData();
    form.append("backup", file, file.name);
    if (options.confirm) form.append("confirm", options.confirm);
    const query = options.dryRun ? "?dryRun=1" : "";
    return apiFetch(`/backup/import${query}`, {
      method: "POST",
      body: form,
    });
  },
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function ifMatchHeaders(rev: number | undefined): Record<string, string> {
  return typeof rev === "number" && Number.isFinite(rev)
    ? { "If-Match": `"rev-${rev}"` }
    : {};
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isUnauthorized(error: unknown): boolean {
  return isApiError(error) && error.status === 401;
}

export function isConflict(error: unknown): boolean {
  return isApiError(error) && (error.status === 409 || error.status === 412);
}

/** 428 (missing If-Match), 412 (stale), or 409 (semantic conflict). */
export function isConcurrencyError(error: unknown): boolean {
  return isApiError(error) && [409, 412, 428].includes(error.status);
}

export function isMissingRoute(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 405 || error.status === 501);
}

export function apiErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 401) return "That password didn't match.";
    if (error.status === 403) {
      if (error.code === "csrf") {
        return (
          error.detail ||
          "This address doesn't match the instance's configured public address."
        );
      }
      return "This action needs a fresh sign-in.";
    }
    if (error.status === 409) {
      return error.detail || "That change conflicts with something else.";
    }
    if (error.status === 412) {
      return "This changed on another device. Refresh and try again.";
    }
    if (error.status === 428) {
      return "Morrow needs a fresh copy before saving. Refresh and try again.";
    }
    if (error.status === 429) {
      return "Too many attempts. Wait a moment and try again.";
    }
    if (error.status >= 500) {
      return "Morrow hit a problem. Your data is safe; try again.";
    }
    return error.detail || error.message || "Something didn't work.";
  }
  if (error instanceof TypeError) {
    return "Can't reach Morrow. Check the server and try again.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "Something didn't work.";
}

/* -------------------------------------------------------------------------- */
/* Assistant / proposals (M4)                                                 */
/* -------------------------------------------------------------------------- */

export type AssistantStatusName =
  | "ready"
  | "disabled"
  | "not_configured"
  | "unconfigured"
  | "unreachable"
  | "model_missing"
  | "model_not_tool_capable"
  | "contract_mismatch"
  | string;

export interface AssistantStatus {
  enabled: boolean;
  available: boolean;
  connected: boolean;
  status: AssistantStatusName;
  model: string | null;
  fallbackModel?: string | null;
  message: string | null;
  version?: string | null;
  pinnedVersion?: string;
  models?: AssistantModel[];
  vision?: boolean;
}

export interface AssistantModel {
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  tools: boolean;
  variants: string[];
  status?: string;
  input?: string[];
  vision?: boolean;
}

export interface ConversationLastError {
  code: string | null;
  message: string;
  at: string;
}

export interface AssistantConversation {
  id: string;
  opencodeSessionId: string | null;
  title: string | null;
  status: "active" | "archived";
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastError?: ConversationLastError | null;
}

export interface AssistantMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  opencodeMessageId: string | null;
  createdAt: string;
}

export interface ProposalPreview {
  operationId: string;
  kind:
    | "create_task"
    | "update_task"
    | "complete_task"
    | "snooze_task"
    | "skip_task"
    | "delete_task";
  taskId: string | null;
  title: string | null;
  detail: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export interface Proposal {
  id: string;
  conversationId: string | null;
  summary: string;
  operations: Array<Record<string, unknown>>;
  baseRev: number | null;
  payloadHash: string;
  expiresAt: string;
  status: "pending" | "applied" | "dismissed" | "expired";
  appliedRev: number | null;
  appliedActivityId: number | null;
  createdAt: string;
  updatedAt: string;
  rev: number;
  preview: ProposalPreview[];
}

export interface AssistantEvent {
  id: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export const assistantApi = {
  status(): Promise<{ status: AssistantStatus }> {
    return apiFetch("/assistant/status");
  },

  models(): Promise<{
    current: string | null;
    status: AssistantStatus;
    models: AssistantModel[];
  }> {
    return apiFetch("/model");
  },

  updateSettings(patch: {
    aiEnabled?: boolean;
    model?: string | null;
    fallbackModel?: string | null;
  }): Promise<{ status: AssistantStatus }> {
    return apiFetch("/assistant/settings", {
      method: "POST",
      body: patch,
    });
  },

  listConversations(): Promise<{ conversations: AssistantConversation[] }> {
    return apiFetch("/assistant/conversations");
  },

  createConversation(title?: string): Promise<{ conversation: AssistantConversation }> {
    return apiFetch("/assistant/conversations", {
      method: "POST",
      body: title ? { title } : {},
    });
  },

  messages(conversationId: string): Promise<{
    conversation: AssistantConversation;
    messages: AssistantMessage[];
    proposals: Proposal[];
    running: boolean;
    lastError?: ConversationLastError | null;
  }> {
    return apiFetch(
      `/assistant/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
  },

  send(
    conversationId: string,
    text: string,
  ): Promise<{
    message: AssistantMessage;
    runId: string;
    status: AssistantStatus;
  }> {
    return apiFetch(
      `/assistant/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: "POST", body: { text } },
    );
  },

  stop(conversationId: string): Promise<{ stopped: boolean }> {
    return apiFetch(
      `/assistant/conversations/${encodeURIComponent(conversationId)}/stop`,
      { method: "POST" },
    );
  },

  planMyDay(input: {
    timezone?: string;
    conversationId?: string | null;
  } = {}): Promise<{
    proposal: Proposal | null;
    summary: string;
    plan: Record<string, unknown>;
  }> {
    return apiFetch("/assistant/plan-my-day", {
      method: "POST",
      body: input,
    });
  },

  undoBatch(batchId: string): Promise<{ undone: number; batchId: string }> {
    return apiFetch("/assistant/undo", {
      method: "POST",
      body: { batchId },
    });
  },
};

export const proposalsApi = {
  list(params: {
    status?: string;
    conversationId?: string;
    limit?: number;
  } = {}): Promise<{ proposals: Proposal[] }> {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    if (params.conversationId) query.set("conversationId", params.conversationId);
    if (params.limit) query.set("limit", String(params.limit));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return apiFetch(`/proposals${suffix}`);
  },

  get(id: string): Promise<{ proposal: Proposal }> {
    return apiFetch(`/proposals/${encodeURIComponent(id)}`);
  },

  apply(
    id: string,
    input: {
      operations?: number[];
      operationIds?: string[];
      payloadHash?: string;
      baseRev?: number;
    },
  ): Promise<{
    proposal: Proposal;
    applied: number;
    batchId: string;
    activityIds: number[];
    appliedRev: number;
  }> {
    return apiFetch(`/proposals/${encodeURIComponent(id)}/apply`, {
      method: "POST",
      body: input,
    });
  },

  dismiss(id: string): Promise<{ proposal: Proposal }> {
    return apiFetch(`/proposals/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
    });
  },

  undo(id: string): Promise<{
    proposal: Proposal;
    undone: number;
    batchId: string;
  }> {
    return apiFetch(`/proposals/${encodeURIComponent(id)}/undo`, {
      method: "POST",
    });
  },
};

/* -------------------------------------------------------------------------- */
/* Providers (M4.1)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Exact shape used (M4.1 contract, backend landing in parallel — adapt if it
 * drifts): GET /api/providers returns
 * `{ providers: [{ id, providerId, label, kind, baseUrl, models, enabled,
 * connected, keyLast4, lastTestOk, lastError }] }`.
 * Keys are write-only: the server never returns them, only `keyLast4`.
 * Step-up (`POST /api/auth/password`) is required before add/rotate/delete.
 */
export interface ProviderRecord {
  id: string;
  providerId: string;
  label: string;
  kind?: string;
  baseUrl?: string | null;
  models: string[];
  enabled: boolean;
  connected: boolean;
  keyLast4?: string | null;
  lastTestOk?: boolean | null;
  lastError?: string | null;
  [key: string]: unknown;
}

export interface ProviderCreateInput {
  preset?: string;
  kind: "preset" | "custom";
  label?: string;
  baseUrl?: string;
  models?: string[];
  key?: string;
  headers?: Record<string, string>;
}

export interface ProviderUpdateInput {
  label?: string;
  baseUrl?: string;
  models?: string[];
  key?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface ProviderTestResult {
  ok: boolean;
  models?: string[];
  error?: string | null;
  message?: string | null;
  [key: string]: unknown;
}

function normalizeProvider(raw: unknown): ProviderRecord {
  const row = unwrapRecord(raw);
  const modelsRaw =
    row["models"] ?? row["modelIds"] ?? row["model_ids"] ?? [];
  const models = Array.isArray(modelsRaw)
    ? modelsRaw
        .map((model) => {
          if (typeof model === "string") return model;
          if (model && typeof model === "object") {
            const entry = model as Record<string, unknown>;
            const id = entry["id"] ?? entry["modelId"] ?? entry["name"];
            return typeof id === "string" ? id : "";
          }
          return "";
        })
        .filter(Boolean)
    : [];
  const enabled =
    row["enabled"] === undefined ? true : boolean(row["enabled"]);
  return {
    ...row,
    id: String(row["id"] ?? row["providerId"] ?? row["provider_id"] ?? ""),
    providerId: String(
      row["providerId"] ?? row["provider_id"] ?? row["preset"] ?? row["id"] ?? "",
    ),
    label: String(
      row["label"] ?? row["name"] ?? row["providerId"] ?? row["id"] ?? "Provider",
    ),
    kind:
      typeof row["kind"] === "string" ? row["kind"] : undefined,
    baseUrl:
      (row["baseUrl"] as string | null | undefined) ??
      (row["base_url"] as string | null | undefined) ??
      null,
    models,
    enabled,
    connected:
      row["connected"] === undefined
        ? row["status"] === "ready" || row["status"] === "ok"
        : boolean(row["connected"]),
    keyLast4:
      (row["keyLast4"] as string | null | undefined) ??
      (row["key_last4"] as string | null | undefined) ??
      null,
    lastTestOk:
      row["lastTestOk"] === undefined && row["last_test_ok"] === undefined
        ? null
        : boolean(row["lastTestOk"] ?? row["last_test_ok"]),
    lastError:
      (row["lastError"] as string | null | undefined) ??
      (row["last_error"] as string | null | undefined) ??
      null,
  };
}

function normalizeProviderPayload(raw: unknown): ProviderRecord[] {
  if (Array.isArray(raw)) return raw.map(normalizeProvider);
  const row = unwrapRecord(raw);
  const list =
    row["providers"] ?? row["data"] ?? row["items"] ?? row["results"] ?? [];
  if (Array.isArray(list)) return (list as unknown[]).map(normalizeProvider);
  if (list && typeof list === "object") {
    const nested = unwrapRecord(list);
    const inner = nested["providers"];
    if (Array.isArray(inner)) return (inner as unknown[]).map(normalizeProvider);
  }
  return [];
}

export const providersApi = {
  async list(signal?: AbortSignal): Promise<{ providers: ProviderRecord[] }> {
    const raw = await apiFetch<unknown>("/providers", { signal });
    return { providers: normalizeProviderPayload(raw) };
  },

  async create(input: ProviderCreateInput): Promise<ProviderRecord> {
    const raw = await apiFetch<unknown>("/providers", {
      method: "POST",
      body: input,
    });
    const row = unwrapRecord(raw);
    return normalizeProvider(row["provider"] ?? row["data"] ?? row);
  },

  async update(id: string, patch: ProviderUpdateInput): Promise<ProviderRecord> {
    const raw = await apiFetch<unknown>(
      `/providers/${encodeURIComponent(id)}`,
      { method: "PATCH", body: patch },
    );
    const row = unwrapRecord(raw);
    return normalizeProvider(row["provider"] ?? row["data"] ?? row);
  },

  remove(id: string): Promise<void> {
    return apiFetch(`/providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  async test(id: string, signal?: AbortSignal): Promise<ProviderTestResult> {
    const raw = await apiFetch<Record<string, unknown>>(
      `/providers/${encodeURIComponent(id)}/test`,
      { method: "POST", signal },
    );
    const test =
      raw["test"] && typeof raw["test"] === "object"
        ? (raw["test"] as Record<string, unknown>)
        : raw;
    const ok =
      typeof test["ok"] === "boolean"
        ? test["ok"]
        : typeof raw["ok"] === "boolean"
          ? raw["ok"]
          : typeof raw["success"] === "boolean"
            ? (raw["success"] as boolean)
            : raw["error"] == null && raw["lastError"] == null;
    const modelsRaw = test["models"] ?? raw["models"];
    return {
      ...raw,
      ...test,
      ok,
      models: Array.isArray(modelsRaw)
        ? (modelsRaw as unknown[]).map((model) => String(model))
        : undefined,
      error:
        (test["error"] as string | null | undefined) ??
        (test["message"] as string | null | undefined) ??
        (raw["error"] as string | null | undefined) ??
        (raw["lastError"] as string | null | undefined) ??
        (raw["detail"] as string | null | undefined) ??
        null,
    };
  },

  async discoverModels(id: string, signal?: AbortSignal): Promise<{ models: string[] }> {
    const raw = await apiFetch<unknown>(
      `/providers/${encodeURIComponent(id)}/discover-models`,
      { method: "POST", signal },
    );
    const row = unwrapRecord(raw);
    const discovery =
      row["discovery"] && typeof row["discovery"] === "object"
        ? (row["discovery"] as Record<string, unknown>)
        : row;
    const list = discovery["models"] ?? row["models"] ?? row["data"] ?? [];
    return {
      models: Array.isArray(list)
        ? (list as unknown[]).map((model) => String(model)).filter(Boolean)
        : [],
    };
  },
};

/**
 * Fetch/ReadableStream SSE (plan §7 assistant stream). The caller owns the
 * AbortController and tracks Last-Event-ID between reconnects.
 */
export async function streamAssistant(
  conversationId: string,
  options: {
    lastEventId?: number | null;
    signal?: AbortSignal;
    onEvent: (event: AssistantEvent) => void;
  },
): Promise<void> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
  };
  if (options.lastEventId != null) {
    headers["Last-Event-ID"] = String(options.lastEventId);
  }
  const response = await fetch(
    `${API_BASE}/assistant/conversations/${encodeURIComponent(conversationId)}/stream`,
    {
      method: "GET",
      headers,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    },
  );
  if (!response.ok) {
    throw new ApiError(response.status, null, "Assistant stream failed.");
  }
  if (!response.body) throw new Error("Assistant stream has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventId: number | null = null;
  let eventType = "message";
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length === 0) {
      eventType = "message";
      return;
    }
    const raw = dataLines.join("\n");
    dataLines = [];
    const type = eventType;
    eventType = "message";
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    const data =
      payload && typeof payload === "object" && "data" in payload
        ? ((payload as { data?: unknown }).data as Record<string, unknown>)
        : (payload as Record<string, unknown>);
    options.onEvent({
      id: eventId ?? 0,
      type,
      at:
        payload && typeof payload === "object" && "at" in payload
          ? String((payload as { at?: unknown }).at ?? "")
          : new Date().toISOString(),
      data: data ?? {},
    });
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const valueText = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "id") {
            const parsed = Number.parseInt(valueText, 10);
            if (Number.isSafeInteger(parsed)) eventId = parsed;
          } else if (field === "event") {
            eventType = valueText;
          } else if (field === "data") {
            dataLines.push(valueText);
          }
        }
        dispatch();
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
