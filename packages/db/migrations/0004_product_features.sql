CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES `users` (`id`) ON DELETE cascade,
	CONSTRAINT "tags_rev_check" CHECK("tags"."rev" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_user_name_unique` ON `tags` (`user_id`, lower(`name`)) WHERE `tags`.`deleted_at` is null;--> statement-breakpoint
CREATE INDEX `tags_user_idx` ON `tags` (`user_id`);--> statement-breakpoint
CREATE TABLE `task_tags` (
	`task_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`task_id`, `tag_id`),
	CONSTRAINT "task_tags_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES `tasks` (`id`) ON DELETE cascade,
	CONSTRAINT "task_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES `tags` (`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_tags_tag_idx` ON `task_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `subtasks` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`sort_key` text DEFAULT '' NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "subtasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES `tasks` (`id`) ON DELETE cascade,
	CONSTRAINT "subtasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES `users` (`id`) ON DELETE cascade,
	CONSTRAINT "subtasks_done_check" CHECK("subtasks"."done" in (0,1)),
	CONSTRAINT "subtasks_rev_check" CHECK("subtasks"."rev" >= 1)
);
--> statement-breakpoint
CREATE INDEX `subtasks_task_sort_idx` ON `subtasks` (`task_id`, `sort_key`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_path` text NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "attachments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES `tasks` (`id`) ON DELETE cascade,
	CONSTRAINT "attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES `users` (`id`) ON DELETE cascade,
	CONSTRAINT "attachments_bytes_check" CHECK("attachments"."bytes" >= 0),
	CONSTRAINT "attachments_rev_check" CHECK("attachments"."rev" >= 1)
);
--> statement-breakpoint
CREATE INDEX `attachments_task_idx` ON `attachments` (`task_id`);--> statement-breakpoint
CREATE TABLE `capture_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`last_used_at` text,
	`created_at` text NOT NULL,
	`revoked_at` text,
	CONSTRAINT "capture_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES `users` (`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capture_tokens_hash_unique` ON `capture_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `capture_tokens_user_idx` ON `capture_tokens` (`user_id`);
