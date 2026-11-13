/**
 * Morrow SQLite schema (§3).
 *
 * Conventions:
 *  - UUIDv7 text ids.
 *  - UTC ISO timestamps with fixed milliseconds.
 *  - Floating local wall times (`YYYY-MM-DDTHH:mm:ss`) or dates (`YYYY-MM-DD`).
 *  - Soft delete + `rev` on mutable tables.
 *  - Fractional `sort_key` for manual order.
 *
 * Important compatibility note: the app-server auth skeleton uses raw SQL and
 * expects `users.username`, `sessions.step_up_at`, `settings.value`, and the
 * singleton `scheduler_state.id = 1`. Those names are preserved here.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// users / sessions
// ---------------------------------------------------------------------------

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().default("owner"),
    passwordHash: text("password_hash").notNull(),
    /** Workspace role: `owner` can administer global settings; `member` cannot. */
    role: text("role").notNull().default("member"),
    timezone: text("timezone").notNull().default("UTC"),
    locale: text("locale"),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("users_username_unique").on(t.username),
    check("users_role_check", sql`${t.role} in ('owner','member')`),
    check("users_rev_check", sql`${t.rev} >= 1`),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    stepUpAt: text("step_up_at"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    absoluteExpiresAt: text("absolute_expires_at").notNull(),
    revokedAt: text("revoked_at"),
    rev: integer("rev").notNull().default(1),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_unique").on(t.tokenHash),
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// lists / tasks
// ---------------------------------------------------------------------------

export const lists = sqliteTable(
  "lists",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    icon: text("icon"),
    sortKey: text("sort_key").notNull().default(""),
    isInbox: integer("is_inbox", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    index("lists_user_sort_idx").on(t.userId, t.sortKey),
    check("lists_rev_check", sql`${t.rev} >= 1`),
  ],
);

export const listMembers = sqliteTable(
  "list_members",
  {
    listId: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.listId, t.userId] }),
    index("list_members_user_idx").on(t.userId),
    index("list_members_list_idx").on(t.listId),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    listId: text("list_id").references(() => lists.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    notes: text("notes"),
    /**
     * CalDAV VTODO identity (Round 4). Client-chosen and stable across
     * updates; null means the legacy `<id>@morrow` fallback. Unique per user
     * among live rows, never globally.
     */
    icalUid: text("ical_uid"),
    /** Relative resource path inside the single `morrow` collection. */
    caldavHref: text("caldav_href"),
    status: text("status").notNull().default("open"),
    priority: integer("priority").notNull().default(0),
    dueAt: text("due_at"),
    dueDate: text("due_date"),
    allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
    timezone: text("timezone"),
    remindAt: text("remind_at"),
    reminderTimeLocal: text("reminder_time_local"),
    remindOffsetMinutes: integer("remind_offset_minutes"),
    snoozedUntil: text("snoozed_until"),
    dtstartLocal: text("dtstart_local"),
    nextOccurrenceAt: text("next_occurrence_at"),
    nextOccurrenceLocal: text("next_occurrence_local"),
    occurrenceSeq: integer("occurrence_seq").notNull().default(0),
    rrule: text("rrule"),
    recurrenceUntilUtc: text("recurrence_until_utc"),
    recurrenceUntilDate: text("recurrence_until_date"),
    recurrenceCount: integer("recurrence_count"),
    wkst: text("wkst"),
    recurrenceMode: text("recurrence_mode").notNull().default("schedule"),
    clampPolicy: text("clamp_policy").notNull().default("skip"),
    seriesEndedAt: text("series_ended_at"),
    missedCount: integer("missed_count").notNull().default(0),
    completedAt: text("completed_at"),
    sortKey: text("sort_key").notNull().default(""),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    index("tasks_user_status_idx").on(t.userId, t.status, t.deletedAt),
    index("tasks_next_occurrence_idx").on(t.nextOccurrenceAt),
    index("tasks_remind_at_idx").on(t.remindAt),
    index("tasks_list_sort_idx").on(t.listId, t.sortKey),
    index("tasks_due_at_idx").on(t.dueAt),
    index("tasks_updated_at_idx").on(t.updatedAt),
    // UID and resource path are unique per CalDAV collection, not across the
    // whole account: list id for listed tasks, user id for unlisted/inbox
    // tasks. Partial indexes let a deleted task's identity be reused.
    uniqueIndex("tasks_collection_ical_uid_unique")
      .on(sql`COALESCE(${t.listId}, ${t.userId})`, t.icalUid)
      .where(sql`${t.icalUid} is not null and ${t.deletedAt} is null`),
    uniqueIndex("tasks_collection_caldav_href_unique")
      .on(sql`COALESCE(${t.listId}, ${t.userId})`, t.caldavHref)
      .where(sql`${t.caldavHref} is not null and ${t.deletedAt} is null`),
    check(
      "tasks_status_check",
      sql`${t.status} in ('open','done','cancelled')`,
    ),
    check("tasks_priority_check", sql`${t.priority} between 0 and 4`),
    check(
      "tasks_recurrence_mode_check",
      sql`${t.recurrenceMode} in ('schedule','completion')`,
    ),
    check(
      "tasks_clamp_policy_check",
      sql`${t.clampPolicy} in ('skip','last-day')`,
    ),
    check("tasks_occurrence_seq_check", sql`${t.occurrenceSeq} >= 0`),
    check("tasks_missed_count_check", sql`${t.missedCount} >= 0`),
    check("tasks_rev_check", sql`${t.rev} >= 1`),
    check(
      "tasks_recurrence_count_check",
      sql`${t.recurrenceCount} is null or ${t.recurrenceCount} > 0`,
    ),
    check(
      "tasks_count_until_exclusive_check",
      sql`${t.recurrenceCount} is null or (${t.recurrenceUntilUtc} is null and ${t.recurrenceUntilDate} is null)`,
    ),
  ],
);

export const taskCompletions = sqliteTable(
  "task_completions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    occurrenceKey: text("occurrence_key").notNull(),
    status: text("status").notNull(),
    completedAt: text("completed_at"),
    source: text("source").notNull().default("user"),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("task_completions_task_occurrence_unique")
      .on(t.taskId, t.occurrenceKey)
      .where(sql`${t.deletedAt} is null`),
    index("task_completions_task_idx").on(t.taskId),
    check(
      "task_completions_status_check",
      sql`${t.status} in ('completed','missed','skipped')`,
    ),
    check(
      "task_completions_source_check",
      sql`${t.source} in ('user','scheduler','import')`,
    ),
    check("task_completions_rev_check", sql`${t.rev} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// tags / subtasks / attachments / capture tokens
// ---------------------------------------------------------------------------

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("tags_user_name_unique")
      .on(t.userId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} is null`),
    index("tags_user_idx").on(t.userId),
    check("tags_rev_check", sql`${t.rev} >= 1`),
  ],
);

export const taskTags = sqliteTable(
  "task_tags",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.tagId] }),
    index("task_tags_tag_idx").on(t.tagId),
  ],
);

/**
 * CalDAV sync journal. Rows are written by SQLite triggers in migration 0008
 * so scheduler, undo, MCP, REST, and CalDAV writes are all covered. The table
 * is deliberately excluded from backups; a restore rotates the token epoch.
 */
export const caldavChanges = sqliteTable(
  "caldav_changes",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    collection: text("collection").notNull().default("morrow"),
    userId: text("user_id").notNull(),
    taskId: text("task_id").notNull(),
    href: text("href").notNull(),
    changeType: text("change_type").notNull(),
    /** Set for a per-occurrence exception resource rather than a base task. */
    exceptionId: text("exception_id"),
    changedAt: text("changed_at").notNull(),
  },
  (t) => [
    index("caldav_changes_user_seq_idx").on(t.userId, t.collection, t.seq),
    index("caldav_changes_task_idx").on(t.taskId),
    check(
      "caldav_changes_change_type_check",
      sql`${t.changeType} in ('create','update','delete')`,
    ),
  ],
);

export const subtasks = sqliteTable(
  "subtasks",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    sortKey: text("sort_key").notNull().default(""),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    index("subtasks_task_sort_idx").on(t.taskId, t.sortKey),
    check("subtasks_done_check", sql`${t.done} in (0,1)`),
    check("subtasks_rev_check", sql`${t.rev} >= 1`),
  ],
);

export const taskRecurrenceExceptions = sqliteTable(
  "task_recurrence_exceptions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Canonical identity: YYYY-MM-DD for all-day, UTC ISO for timed. */
    recurrenceId: text("recurrence_id").notNull(),
    caldavHref: text("caldav_href").notNull(),
    patchJson: text("patch_json").notNull().default("{}"),
    status: text("status"),
    completedAt: text("completed_at"),
    icalExtraJson: text("ical_extra_json"),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("task_recurrence_exceptions_task_recurrence_unique")
      .on(t.taskId, t.recurrenceId)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex("task_recurrence_exceptions_task_href_unique")
      .on(t.taskId, t.caldavHref)
      .where(sql`${t.deletedAt} is null`),
    index("task_recurrence_exceptions_task_idx").on(t.taskId),
    check(
      "task_recurrence_exceptions_status_check",
      sql`${t.status} is null or ${t.status} in ('open','done','cancelled')`,
    ),
    check("task_recurrence_exceptions_rev_check", sql`${t.rev} >= 1`),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    storagePath: text("storage_path").notNull(),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    index("attachments_task_idx").on(t.taskId),
    check("attachments_bytes_check", sql`${t.bytes} >= 0`),
    check("attachments_rev_check", sql`${t.rev} >= 1`),
  ],
);

export const captureTokens = sqliteTable(
  "capture_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Capture/email tokens and CalDAV credentials are not interchangeable. */
    kind: text("kind").notNull().default("capture"),
    tokenHash: text("token_hash").notNull(),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    uniqueIndex("capture_tokens_hash_unique").on(t.tokenHash),
    index("capture_tokens_user_idx").on(t.userId),
    index("capture_tokens_kind_idx").on(t.userId, t.kind),
    check("capture_tokens_kind_check", sql`${t.kind} in ('capture','caldav')`),
  ],
);

// ---------------------------------------------------------------------------
// offline idempotency
// ---------------------------------------------------------------------------

export const operations = sqliteTable("operations", {
  opId: text("op_id").primaryKey(),
  kind: text("kind").notNull(),
  entityId: text("entity_id"),
  baseRev: integer("base_rev"),
  payloadHash: text("payload_hash"),
  resultJson: text("result_json").notNull(),
  createdAt: text("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// push / delivery
// ---------------------------------------------------------------------------

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    endpointHash: text("endpoint_hash").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    deviceLabel: text("device_label"),
    platform: text("platform"),
    vapidKeyId: text("vapid_key_id"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    failCount: integer("fail_count").notNull().default(0),
    lastSuccessAt: text("last_success_at"),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("push_subscriptions_endpoint_hash_unique").on(t.endpointHash),
    index("push_subscriptions_user_idx").on(t.userId),
    check("push_subscriptions_fail_count_check", sql`${t.failCount} >= 0`),
  ],
);

export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    occurrenceKey: text("occurrence_key").notNull(),
    kind: text("kind").notNull(),
    channel: text("channel").notNull(),
    subscriptionId: text("subscription_id").notNull().default(""),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at"),
    leaseUntil: text("lease_until"),
    claimToken: text("claim_token"),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    sentAt: text("sent_at"),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("deliveries_dedupe_unique").on(
      t.taskId,
      t.occurrenceKey,
      t.kind,
      t.channel,
      t.subscriptionId,
    ),
    index("deliveries_due_idx").on(t.status, t.nextAttemptAt),
    index("deliveries_lease_idx").on(t.status, t.leaseUntil),
    index("deliveries_task_idx").on(t.taskId),
    check(
      "deliveries_kind_check",
      sql`${t.kind} in ('reminder','digest','test')`,
    ),
    check(
      "deliveries_channel_check",
      sql`${t.channel} in ('webpush','ntfy')`,
    ),
    check(
      "deliveries_status_check",
      sql`${t.status} in ('pending','retry','sending','sent','failed','dead','skipped')`,
    ),
    check("deliveries_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// agent conversations / messages / proposals
// ---------------------------------------------------------------------------

export const agentConversations = sqliteTable(
  "agent_conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    opencodeSessionId: text("opencode_session_id"),
    title: text("title"),
    status: text("status").notNull().default("active"),
    lastMessageAt: text("last_message_at"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorAt: text("last_error_at"),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("agent_conversations_opencode_session_unique")
      .on(t.opencodeSessionId)
      .where(sql`${t.opencodeSessionId} is not null`),
    index("agent_conversations_user_updated_idx").on(t.userId, t.updatedAt),
    check(
      "agent_conversations_status_check",
      sql`${t.status} in ('active','archived')`,
    ),
  ],
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => agentConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    partsJson: text("parts_json"),
    opencodeMessageId: text("opencode_message_id"),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    index("agent_messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
    check(
      "agent_messages_role_check",
      sql`${t.role} in ('user','assistant','system')`,
    ),
  ],
);

// Activity is declared before proposals because proposals reference its seq.
export const activity = sqliteTable(
  "activity",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    batchId: text("batch_id"),
    opId: text("op_id"),
    actor: text("actor"),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    summary: text("summary"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("activity_created_at_idx").on(t.createdAt),
    index("activity_entity_idx").on(t.entityType, t.entityId),
    index("activity_batch_idx").on(t.batchId),
    index("activity_entity_action_seq_idx").on(t.entityId, t.action, t.seq),
  ],
);

export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").references(
      () => agentConversations.id,
      { onDelete: "set null" },
    ),
    summary: text("summary").notNull(),
    operationsJson: text("operations_json").notNull(),
    baseRev: integer("base_rev"),
    payloadHash: text("payload_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    status: text("status").notNull().default("pending"),
    appliedRev: integer("applied_rev"),
    appliedActivityId: integer("applied_activity_id").references(
      () => activity.seq,
      { onDelete: "set null" },
    ),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    index("proposals_status_expires_idx").on(t.status, t.expiresAt),
    index("proposals_conversation_idx").on(t.conversationId),
    check(
      "proposals_status_check",
      sql`${t.status} in ('pending','applied','dismissed','expired')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// provider credentials (M4.1) — metadata only, NEVER the secret
// ---------------------------------------------------------------------------

/**
 * A provider credential row describes a model provider the user connected in
 * Morrow. The API key itself lives in `SECRETS_DIR/providers/<provider_id>.key`
 * (0600) and is referenced from the sidecar overlay as `{file:...}`. This table
 * deliberately stores only a display label, the key's last four characters and
 * a SHA-256 fingerprint for tamper detection. Backups exclude this table and
 * the key directory entirely.
 */
export const providerCredentials = sqliteTable(
  "provider_credentials",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    label: text("label").notNull(),
    kind: text("kind").notNull(),
    baseUrl: text("base_url"),
    modelsJson: text("models_json").notNull().default("[]"),
    npmPkg: text("npm_pkg"),
    headersJson: text("headers_json").notNull().default("{}"),
    keyLast4: text("key_last4"),
    keyFingerprint: text("key_fingerprint"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastTestAt: text("last_test_at"),
    lastTestOk: integer("last_test_ok", { mode: "boolean" }),
    lastError: text("last_error"),
    rev: integer("rev").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("provider_credentials_provider_id_unique")
      .on(t.providerId)
      .where(sql`${t.deletedAt} is null`),
    index("provider_credentials_updated_idx").on(t.updatedAt),
    check(
      "provider_credentials_kind_check",
      sql`${t.kind} in ('preset','custom')`,
    ),
    check("provider_credentials_rev_check", sql`${t.rev} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// settings / backup / scheduler
// ---------------------------------------------------------------------------

export const settings = sqliteTable(
  "settings",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    rev: integer("rev").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [check("settings_rev_check", sql`${t.rev} >= 1`)],
);

export const backupRuns = sqliteTable(
  "backup_runs",
  {
    id: text("id").primaryKey(),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    bytes: integer("bytes").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    createdAt: text("created_at").notNull(),
    status: text("status").notNull(),
  },
  (t) => [
    index("backup_runs_created_at_idx").on(t.createdAt),
    check("backup_runs_bytes_check", sql`${t.bytes} >= 0`),
  ],
);

export const schedulerState = sqliteTable(
  "scheduler_state",
  {
    id: integer("id").primaryKey(),
    lastTickAt: text("last_tick_at"),
    lastCatchupAt: text("last_catchup_at"),
    leaseOwner: text("lease_owner"),
    leaseUntil: text("lease_until"),
  },
  (t) => [check("scheduler_state_singleton_check", sql`${t.id} = 1`)],
);

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type List = typeof lists.$inferSelect;
export type NewList = typeof lists.$inferInsert;
export type ListMember = typeof listMembers.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type TaskCompletion = typeof taskCompletions.$inferSelect;
export type NewTaskCompletion = typeof taskCompletions.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type TaskTag = typeof taskTags.$inferSelect;
export type Subtask = typeof subtasks.$inferSelect;
export type NewSubtask = typeof subtasks.$inferInsert;
export type Attachment = typeof attachments.$inferSelect;
export type CaptureToken = typeof captureTokens.$inferSelect;
export type Operation = typeof operations.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type Delivery = typeof deliveries.$inferSelect;
export type AgentConversation = typeof agentConversations.$inferSelect;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type Proposal = typeof proposals.$inferSelect;
export type ProviderCredential = typeof providerCredentials.$inferSelect;
export type NewProviderCredential = typeof providerCredentials.$inferInsert;
export type Activity = typeof activity.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type BackupRun = typeof backupRuns.$inferSelect;
export type SchedulerState = typeof schedulerState.$inferSelect;
