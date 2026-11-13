CREATE TABLE "users" (
  "id" text PRIMARY KEY NOT NULL,
  "username" text DEFAULT 'owner' NOT NULL,
  "password_hash" text NOT NULL,
  "timezone" text DEFAULT 'UTC' NOT NULL,
  "locale" text,
  "rev" integer DEFAULT 1 NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "deleted_at" text,
  CONSTRAINT "users_rev_check" CHECK ("rev" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" ("username");
--> statement-breakpoint
CREATE TABLE "sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "user_agent" text,
  "ip" text,
  "step_up_at" text,
  "created_at" text NOT NULL,
  "last_seen_at" text NOT NULL,
  "expires_at" text NOT NULL,
  "absolute_expires_at" text NOT NULL,
  "revoked_at" text,
  "rev" integer DEFAULT 1 NOT NULL,
  "deleted_at" text,
  CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" ("token_hash");
--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" ("expires_at");
--> statement-breakpoint
CREATE TABLE "lists" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "color" text,
  "icon" text,
  "sort_key" text DEFAULT '' NOT NULL,
  "is_inbox" integer DEFAULT 0 NOT NULL,
  "created_by" text,
  "updated_by" text,
  "rev" integer DEFAULT 1 NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "deleted_at" text,
  CONSTRAINT "lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE cascade,
  CONSTRAINT "lists_rev_check" CHECK ("rev" >= 1)
);
--> statement-breakpoint
CREATE INDEX "lists_user_sort_idx" ON "lists" ("user_id", "sort_key");
--> statement-breakpoint
CREATE TABLE "tasks" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "list_id" text,
  "title" text NOT NULL,
  "notes" text,
  "status" text DEFAULT 'open' NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "due_at" text,
  "due_date" text,
  "all_day" integer DEFAULT 0 NOT NULL,
  "timezone" text,
  "remind_at" text,
  "reminder_time_local" text,
  "remind_offset_minutes" integer,
  "snoozed_until" text,
  "dtstart_local" text,
  "next_occurrence_at" text,
  "next_occurrence_local" text,
  "occurrence_seq" integer DEFAULT 0 NOT NULL,
  "rrule" text,
  "recurrence_until_utc" text,
  "recurrence_until_date" text,
  "recurrence_count" integer,
  "wkst" text,
  "recurrence_mode" text DEFAULT 'schedule' NOT NULL,
  "clamp_policy" text DEFAULT 'skip' NOT NULL,
  "series_ended_at" text,
  "missed_count" integer DEFAULT 0 NOT NULL,
  "completed_at" text,
  "sort_key" text DEFAULT '' NOT NULL,
  "created_by" text,
  "updated_by" text,
  "rev" integer DEFAULT 1 NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "deleted_at" text,
  CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE cascade,
  CONSTRAINT "tasks_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "lists" ("id") ON DELETE set null,
  CONSTRAINT "tasks_status_check" CHECK ("status" in ('open','done','cancelled')),
  CONSTRAINT "tasks_priority_check" CHECK ("priority" between 0 and 4),
  CONSTRAINT "tasks_recurrence_mode_check" CHECK ("recurrence_mode" in ('schedule','completion')),
  CONSTRAINT "tasks_clamp_policy_check" CHECK ("clamp_policy" in ('skip','last-day')),
  CONSTRAINT "tasks_occurrence_seq_check" CHECK ("occurrence_seq" >= 0),
  CONSTRAINT "tasks_missed_count_check" CHECK ("missed_count" >= 0),
  CONSTRAINT "tasks_rev_check" CHECK ("rev" >= 1),
  CONSTRAINT "tasks_recurrence_count_check" CHECK ("recurrence_count" is null or "recurrence_count" > 0),
  CONSTRAINT "tasks_count_until_exclusive_check" CHECK ("recurrence_count" is null or ("recurrence_until_utc" is null and "recurrence_until_date" is null))
);
--> statement-breakpoint
CREATE INDEX "tasks_user_status_idx" ON "tasks" ("user_id", "status", "deleted_at");
--> statement-breakpoint
CREATE INDEX "tasks_next_occurrence_idx" ON "tasks" ("next_occurrence_at");
--> statement-breakpoint
CREATE INDEX "tasks_remind_at_idx" ON "tasks" ("remind_at");
--> statement-breakpoint
CREATE INDEX "tasks_list_sort_idx" ON "tasks" ("list_id", "sort_key");
--> statement-breakpoint
CREATE INDEX "tasks_due_at_idx" ON "tasks" ("due_at");
--> statement-breakpoint
CREATE INDEX "tasks_updated_at_idx" ON "tasks" ("updated_at");
--> statement-breakpoint
CREATE TABLE "task_completions" (
  "id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL,
  "occurrence_key" text NOT NULL,
  "status" text NOT NULL,
  "completed_at" text,
  "source" text DEFAULT 'user' NOT NULL,
  "rev" integer DEFAULT 1 NOT NULL,
  "created_at" text NOT NULL,
  "deleted_at" text,
  CONSTRAINT "task_completions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE cascade,
  CONSTRAINT "task_completions_status_check" CHECK ("status" in ('completed','missed','skipped')),
  CONSTRAINT "task_completions_source_check" CHECK ("source" in ('user','scheduler','import')),
  CONSTRAINT "task_completions_rev_check" CHECK ("rev" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "task_completions_task_occurrence_unique" ON "task_completions" ("task_id", "occurrence_key") WHERE "deleted_at" is null;
--> statement-breakpoint
CREATE INDEX "task_completions_task_idx" ON "task_completions" ("task_id");
--> statement-breakpoint
CREATE TABLE "operations" (
  "op_id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "entity_id" text,
  "base_rev" integer,
  "payload_hash" text,
  "result_json" text NOT NULL,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "endpoint" text NOT NULL,
  "endpoint_hash" text NOT NULL,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "device_label" text,
  "platform" text,
  "vapid_key_id" text,
  "enabled" integer DEFAULT 1 NOT NULL,
  "fail_count" integer DEFAULT 0 NOT NULL,
  "last_success_at" text,
  "rev" integer DEFAULT 1 NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "deleted_at" text,
  CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE cascade,
  CONSTRAINT "push_subscriptions_fail_count_check" CHECK ("fail_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_hash_unique" ON "push_subscriptions" ("endpoint_hash");
--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" ("user_id");
--> statement-breakpoint
CREATE TABLE "deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "task_id" text NOT NULL,
  "occurrence_key" text NOT NULL,
  "kind" text NOT NULL,
  "channel" text NOT NULL,
  "subscription_id" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" text,
  "lease_until" text,
  "claim_token" text,
  "last_status" text,
  "last_error" text,
  "sent_at" text,
  "rev" integer DEFAULT 1 NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "deleted_at" text,
  CONSTRAINT "deliveries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE cascade,
  CONSTRAINT "deliveries_kind_check" CHECK ("kind" in ('reminder','digest','test')),
  CONSTRAINT "deliveries_channel_check" CHECK ("channel" in ('webpush','ntfy')),
  CONSTRAINT "deliveries_status_check" CHECK ("status" in ('pending','retry','sending','sent','failed','dead','skipped')),
  CONSTRAINT "deliveries_attempts_check" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_dedupe_unique" ON "deliveries" ("task_id", "occurrence_key", "kind", "channel", "subscription_id");
--> statement-breakpoint
CREATE INDEX "deliveries_due_idx" ON "deliveries" ("status", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX "deliveries_lease_idx" ON "deliveries" ("status", "lease_until");
--> statement-breakpoint
CREATE INDEX "deliveries_task_idx" ON "deliveries" ("task_id");
--> statement-breakpoint
CREATE TABLE "agent_conversations" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "opencode_session_id" text,
  "title" text,
  "status" text DEFAULT 'active' NOT NULL,
  "last_message_at" text,
  "rev" integer DEFAULT 1 NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "deleted_at" text,
  CONSTRAINT "agent_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE cascade,
  CONSTRAINT "agent_conversations_status_check" CHECK ("status" in ('active','archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_conversations_opencode_session_unique" ON "agent_conversations" ("opencode_session_id") WHERE "opencode_session_id" is not null;
--> statement-breakpoint
CREATE INDEX "agent_conversations_user_updated_idx" ON "agent_conversations" ("user_id", "updated_at");
--> statement-breakpoint
CREATE TABLE "agent_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "parts_json" text,
  "opencode_message_id" text,
  "rev" integer DEFAULT 1 NOT NULL,
  "created_at" text NOT NULL,
  "deleted_at" text,
  CONSTRAINT "agent_messages_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "agent_conversations" ("id") ON DELETE cascade,
  CONSTRAINT "agent_messages_role_check" CHECK ("role" in ('user','assistant','system'))
);
--> statement-breakpoint
CREATE INDEX "agent_messages_conversation_created_idx" ON "agent_messages" ("conversation_id", "created_at");
--> statement-breakpoint
CREATE TABLE "activity" (
  "seq" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "batch_id" text,
  "op_id" text,
  "actor" text,
  "actor_id" text,
  "action" text NOT NULL,
  "entity_type" text,
  "entity_id" text,
  "before_json" text,
  "after_json" text,
  "summary" text,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activity_created_at_idx" ON "activity" ("created_at");
--> statement-breakpoint
CREATE INDEX "activity_entity_idx" ON "activity" ("entity_type", "entity_id");
--> statement-breakpoint
CREATE INDEX "activity_batch_idx" ON "activity" ("batch_id");
--> statement-breakpoint
CREATE TABLE "proposals" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text,
  "summary" text NOT NULL,
  "operations_json" text NOT NULL,
  "base_rev" integer,
  "payload_hash" text NOT NULL,
  "expires_at" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "applied_rev" integer,
  "applied_activity_id" integer,
  "rev" integer DEFAULT 1 NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "deleted_at" text,
  CONSTRAINT "proposals_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "agent_conversations" ("id") ON DELETE set null,
  CONSTRAINT "proposals_applied_activity_id_activity_seq_fk" FOREIGN KEY ("applied_activity_id") REFERENCES "activity" ("seq") ON DELETE set null,
  CONSTRAINT "proposals_status_check" CHECK ("status" in ('pending','applied','dismissed','expired'))
);
--> statement-breakpoint
CREATE INDEX "proposals_status_expires_idx" ON "proposals" ("status", "expires_at");
--> statement-breakpoint
CREATE INDEX "proposals_conversation_idx" ON "proposals" ("conversation_id");
--> statement-breakpoint
CREATE TABLE "settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text NOT NULL,
  "rev" integer DEFAULT 1 NOT NULL,
  "updated_at" text NOT NULL,
  "deleted_at" text,
  CONSTRAINT "settings_rev_check" CHECK ("rev" >= 1)
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "path" text NOT NULL,
  "sha256" text NOT NULL,
  "bytes" integer NOT NULL,
  "schema_version" integer NOT NULL,
  "created_at" text NOT NULL,
  "status" text NOT NULL,
  CONSTRAINT "backup_runs_bytes_check" CHECK ("bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX "backup_runs_created_at_idx" ON "backup_runs" ("created_at");
--> statement-breakpoint
CREATE TABLE "scheduler_state" (
  "id" integer PRIMARY KEY NOT NULL,
  "last_tick_at" text,
  "last_catchup_at" text,
  "lease_owner" text,
  "lease_until" text,
  CONSTRAINT "scheduler_state_singleton_check" CHECK ("id" = 1)
);
--> statement-breakpoint
INSERT OR IGNORE INTO "scheduler_state" ("id") VALUES (1);
