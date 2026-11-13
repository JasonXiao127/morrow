-- Phase 2: CalDAV change journal for sync-collection.
--
-- Triggers are used deliberately: task mutations come from REST, MCP,
-- CalDAV, the scheduler, undo, and restore. Recording them in one place keeps
-- sync tokens correct without requiring every route to call a journal helper
-- (the full unified mutation service remains future work).
CREATE TABLE `caldav_changes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection` text DEFAULT 'morrow' NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`href` text NOT NULL,
	`change_type` text NOT NULL,
	`changed_at` text NOT NULL,
	CONSTRAINT "caldav_changes_change_type_check" CHECK (`change_type` in ('create','update','delete'))
);
--> statement-breakpoint
CREATE INDEX `caldav_changes_user_seq_idx` ON `caldav_changes` (`user_id`, `collection`, `seq`);
--> statement-breakpoint
CREATE INDEX `caldav_changes_task_idx` ON `caldav_changes` (`task_id`);
--> statement-breakpoint
CREATE TRIGGER `tasks_caldav_insert`
AFTER INSERT ON `tasks`
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`)
	VALUES ('morrow', NEW.`user_id`, NEW.`id`,
	        COALESCE(NEW.`caldav_href`, NEW.`id` || '.ics'), 'create', NEW.`created_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_caldav_update`
AFTER UPDATE ON `tasks`
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`)
	VALUES ('morrow', NEW.`user_id`, NEW.`id`,
	        COALESCE(NEW.`caldav_href`, NEW.`id` || '.ics'),
	        CASE WHEN NEW.`deleted_at` IS NOT NULL AND OLD.`deleted_at` IS NULL
	             THEN 'delete' ELSE 'update' END,
	        NEW.`updated_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_caldav_delete`
AFTER DELETE ON `tasks`
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`)
	VALUES ('morrow', OLD.`user_id`, OLD.`id`,
	        COALESCE(OLD.`caldav_href`, OLD.`id` || '.ics'), 'delete', OLD.`updated_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `task_tags_caldav_insert`
AFTER INSERT ON `task_tags`
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`)
	SELECT 'morrow', t.`user_id`, t.`id`,
	       COALESCE(t.`caldav_href`, t.`id` || '.ics'), 'update', t.`updated_at`
	  FROM `tasks` t WHERE t.`id` = NEW.`task_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `task_tags_caldav_delete`
AFTER DELETE ON `task_tags`
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`)
	SELECT 'morrow', t.`user_id`, t.`id`,
	       COALESCE(t.`caldav_href`, t.`id` || '.ics'), 'update', t.`updated_at`
	  FROM `tasks` t WHERE t.`id` = OLD.`task_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `tags_caldav_update`
AFTER UPDATE OF `name`, `deleted_at` ON `tags`
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`)
	SELECT 'morrow', t.`user_id`, t.`id`,
	       COALESCE(t.`caldav_href`, t.`id` || '.ics'), 'update', NEW.`updated_at`
	  FROM `task_tags` tt
	  JOIN `tasks` t ON t.`id` = tt.`task_id`
	 WHERE tt.`tag_id` = NEW.`id`;
END;
