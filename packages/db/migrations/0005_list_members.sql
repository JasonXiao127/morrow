CREATE TABLE `list_members` (
	`list_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`list_id`, `user_id`),
	CONSTRAINT "list_members_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES `lists` (`id`) ON DELETE cascade,
	CONSTRAINT "list_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES `users` (`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `list_members_user_idx` ON `list_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `list_members_list_idx` ON `list_members` (`list_id`);
