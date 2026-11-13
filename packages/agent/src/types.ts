/**
 * Shared types for the Morrow agent shim (plan §6).
 *
 * The shim is deliberately transport-agnostic: the MCP server and the REST
 * assistant routes call the same policy, quota, store, and proposal code.
 */

export type AgentActor = "user" | "agent" | "scheduler" | "system";

export interface AgentModelRef {
  providerID: string;
  model: string;
  variant?: string;
}

export interface AgentModelSummary {
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  tools: boolean;
  variants: string[];
  status?: string;
  /** Raw `capabilities.input` from the sidecar (e.g. ["text","image"]). */
  input: string[];
  /** True when the model accepts image input. */
  vision: boolean;
}

export type AgentStatusName =
  | "ready"
  | "disabled"
  | "not_configured"
  | "unconfigured"
  | "unreachable"
  | "model_missing"
  | "model_not_tool_capable"
  | "contract_mismatch";

export interface AgentStatus {
  enabled: boolean;
  available: boolean;
  connected: boolean;
  status: AgentStatusName;
  model: string | null;
  /** Optional recovery model the owner can switch to manually. */
  fallbackModel?: string | null;
  message: string | null;
  version?: string | null;
  pinnedVersion?: string;
  models?: AgentModelSummary[];
  /** True when the selected model accepts image input. */
  vision?: boolean;
}

export interface PromptFile {
  /** Data URL: `data:<mime>;base64,...` */
  uri: string;
  name: string;
  description?: string;
}

export interface ConversationLastError {
  code: string | null;
  message: string;
  at: string;
}

export interface TaskView {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  priority: number;
  listId: string | null;
  dueAt: string | null;
  dueDate: string | null;
  allDay: boolean;
  timezone: string | null;
  remindAt: string | null;
  reminderTimeLocal: string | null;
  remindOffsetMinutes: number | null;
  snoozedUntil: string | null;
  rrule: string | null;
  nextOccurrenceAt: string | null;
  nextOccurrenceLocal: string | null;
  completedAt: string | null;
  rev: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface TaskListRecord {
  id: string;
  name: string;
  color: string | null;
  isInbox: boolean;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCreateInput {
  id?: string;
  title: string;
  notes?: string | null;
  listId?: string | null;
  priority?: number;
  dueAt?: string | null;
  dueDate?: string | null;
  allDay?: boolean;
  timezone?: string | null;
  remindAt?: string | null;
  reminderTimeLocal?: string | null;
  remindOffsetMinutes?: number | null;
  rrule?: string | null;
  dtstartLocal?: string | null;
  recurrenceUntilUtc?: string | null;
  recurrenceUntilDate?: string | null;
  recurrenceCount?: number | null;
  wkst?: string | null;
  recurrenceMode?: "schedule" | "completion";
  clampPolicy?: "skip" | "last-day";
}

export interface TaskUpdateInput {
  title?: string;
  notes?: string | null;
  listId?: string | null;
  priority?: number;
  status?: "open" | "done" | "cancelled";
  dueAt?: string | null;
  dueDate?: string | null;
  allDay?: boolean;
  timezone?: string | null;
  remindAt?: string | null;
  reminderTimeLocal?: string | null;
  remindOffsetMinutes?: number | null;
  snoozedUntil?: string | null;
  rrule?: string | null;
  dtstartLocal?: string | null;
  nextOccurrenceAt?: string | null;
  nextOccurrenceLocal?: string | null;
  occurrenceSeq?: number;
  recurrenceUntilUtc?: string | null;
  recurrenceUntilDate?: string | null;
  recurrenceCount?: number | null;
  wkst?: string | null;
  recurrenceMode?: "schedule" | "completion";
  clampPolicy?: "skip" | "last-day";
  seriesEndedAt?: string | null;
  missedCount?: number;
  completedAt?: string | null;
  sortKey?: string;
}

export type ProposalOperation =
  | {
      kind: "create_task";
      operationId: string;
      input: TaskCreateInput;
      title?: string;
    }
  | {
      kind: "update_task";
      operationId: string;
      taskId: string;
      baseRev?: number;
      patch: TaskUpdateInput;
      title?: string;
    }
  | {
      kind: "complete_task";
      operationId: string;
      taskId: string;
      baseRev?: number;
      occurrenceKey?: string;
      title?: string;
    }
  | {
      kind: "snooze_task";
      operationId: string;
      taskId: string;
      baseRev?: number;
      until: string;
      title?: string;
    }
  | {
      kind: "skip_task";
      operationId: string;
      taskId: string;
      baseRev?: number;
      occurrenceKey?: string;
      title?: string;
    }
  | {
      kind: "delete_task";
      operationId: string;
      taskId: string;
      baseRev?: number;
      title?: string;
    };

export type ProposalOperationKind = ProposalOperation["kind"];

export interface ProposalPreview {
  operationId: string;
  kind: ProposalOperationKind;
  taskId: string | null;
  title: string | null;
  detail: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface ProposalRecord {
  id: string;
  conversationId: string | null;
  summary: string;
  operations: ProposalOperation[];
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

export interface AssistantMessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  opencodeMessageId: string | null;
  createdAt: string;
}

export interface ConversationRecord {
  id: string;
  opencodeSessionId: string | null;
  title: string | null;
  status: "active" | "archived";
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastError: ConversationLastError | null;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  summary: string;
}

export interface WriteResult<T> {
  value: T;
  before: unknown;
  after: unknown;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
}

export interface McpAuthContext {
  tokenId: string;
  scopes: string[];
}

export interface McpToolContext {
  store: import("./store.js").TaskStore;
  quotas: import("./quotas.js").QuotaTracker;
  auth: McpAuthContext;
  sessionId: string | null;
  actorId: string;
  emit?: (event: {
    type: string;
    conversationId: string | null;
    data: Record<string, unknown>;
  }) => void;
  now?: Date;
}

export class AgentError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.status = status;
  }
}
