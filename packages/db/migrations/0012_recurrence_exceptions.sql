-- Phase 3: per-occurrence recurrence exceptions (RFC RECURRENCE-ID).
CREATE TABLE `task_recurrence_exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`recurrence_id` text NOT NULL,
	`caldav_href` text NOT NULL,
	`patch_json` text DEFAULT '{}' NOT NULL,
	`status` text,
	`completed_at` text,
	`ical_extra_json` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "task_recurrence_exceptions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES `tasks` (`id`) ON DELETE cascade,
	CONSTRAINT "task_recurrence_exceptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES `users` (`id`) ON DELETE cascade,
	CONSTRAINT "task_recurrence_exceptions_status_check" CHECK (`status` is null or `status` in ('open','done','cancelled')),
	CONSTRAINT "task_recurrence_exceptions_rev_check" CHECK (`rev` >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_recurrence_exceptions_task_recurrence_unique`
  ON `task_recurrence_exceptions` (`task_id`, `recurrence_id`)
  WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `task_recurrence_exceptions_task_href_unique`
  ON `task_recurrence_exceptions` (`task_id`, `caldav_href`)
  WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `task_recurrence_exceptions_task_idx`
  ON `task_recurrence_exceptions` (`task_id`);--> statement-breakpoint
ALTER TABLE `caldav_changes` ADD `exception_id` text;--> statement-breakpoint
CREATE TRIGGER `recurrence_exceptions_caldav_insert`
AFTER INSERT ON `task_recurrence_exceptions`
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`, `exception_id`)
	SELECT
	  CASE
	    WHEN t.`list_id` IS NULL THEN 'inbox'
	    WHEN EXISTS (
	      SELECT 1 FROM `lists` l
	       WHERE l.`id` = t.`list_id` AND l.`is_inbox` = 1
	         AND l.`user_id` = t.`user_id`
	    ) THEN 'inbox'
	    ELSE t.`list_id`
	  END,
	  t.`user_id`, t.`id`, NEW.`caldav_href`, 'update', NEW.`created_at`, NEW.`id`
	  FROM `tasks` t WHERE t.`id` = NEW.`task_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `recurrence_exceptions_caldav_update`
AFTER UPDATE ON `task_recurrence_exceptions`
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`, `exception_id`)
	SELECT
	  CASE
	    WHEN t.`list_id` IS NULL THEN 'inbox'
	    WHEN EXISTS (
	      SELECT 1 FROM `lists` l
	       WHERE l.`id` = t.`list_id` AND l.`is_inbox` = 1
	         AND l.`user_id` = t.`user_id`
	    ) THEN 'inbox'
	    ELSE t.`list_id`
	  END,
	  t.`user_id`, t.`id`, NEW.`caldav_href`,
	  CASE WHEN NEW.`deleted_at` IS NOT NULL AND OLD.`deleted_at` IS NULL
	       THEN 'delete' ELSE 'update' END,
	  NEW.`updated_at`, NEW.`id`
	  FROM `tasks` t WHERE t.`id` = NEW.`task_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `recurrence_exceptions_caldav_delete`
AFTER DELETE ON `task_recurrence_exceptions`
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`, `exception_id`)
	SELECT
	  CASE
	    WHEN t.`list_id` IS NULL THEN 'inbox'
	    WHEN EXISTS (
	      SELECT 1 FROM `lists` l
	       WHERE l.`id` = t.`list_id` AND l.`is_inbox` = 1
	         AND l.`user_id` = t.`user_id`
	    ) THEN 'inbox'
	    ELSE t.`list_id`
	  END,
	  t.`user_id`, t.`id`, OLD.`caldav_href`, 'delete', OLD.`updated_at`, OLD.`id`
	  FROM `tasks` t WHERE t.`id` = OLD.`task_id`;
END;
--> statement-breakpoint
-- A soft-deleted/reopened series hides/reveals its exception resources.
CREATE TRIGGER `tasks_caldav_exceptions_visibility`
AFTER UPDATE OF `deleted_at` ON `tasks`
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`, `exception_id`)
	SELECT
	  CASE
	    WHEN NEW.`list_id` IS NULL THEN 'inbox'
	    WHEN EXISTS (
	      SELECT 1 FROM `lists` l
	       WHERE l.`id` = NEW.`list_id` AND l.`is_inbox` = 1
	         AND l.`user_id` = NEW.`user_id`
	    ) THEN 'inbox'
	    ELSE NEW.`list_id`
	  END,
	  NEW.`user_id`, NEW.`id`, e.`caldav_href`,
	  CASE WHEN NEW.`deleted_at` IS NOT NULL THEN 'delete' ELSE 'update' END,
	  NEW.`updated_at`, e.`id`
	  FROM `task_recurrence_exceptions` e
	 WHERE e.`task_id` = NEW.`id` AND e.`deleted_at` IS NULL
	   AND (OLD.`deleted_at` IS NULL) <> (NEW.`deleted_at` IS NULL);
END;
