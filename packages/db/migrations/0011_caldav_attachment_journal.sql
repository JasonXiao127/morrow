-- CalDAV: attachment metadata changes move the task's resource ETag and must
-- appear in sync-collection responses. Bytes stay on disk; only the journaled
-- task resource is touched.
CREATE TRIGGER `attachments_caldav_insert`
AFTER INSERT ON `attachments`
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`)
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
	  t.`user_id`, t.`id`,
	  COALESCE(t.`caldav_href`, t.`id` || '.ics'), 'update', NEW.`created_at`
	  FROM `tasks` t WHERE t.`id` = NEW.`task_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `attachments_caldav_update`
AFTER UPDATE OF `deleted_at` ON `attachments`
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`)
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
	  t.`user_id`, t.`id`,
	  COALESCE(t.`caldav_href`, t.`id` || '.ics'), 'update',
	  COALESCE(NEW.`deleted_at`, NEW.`created_at`)
	  FROM `tasks` t WHERE t.`id` = NEW.`task_id`;
END;
