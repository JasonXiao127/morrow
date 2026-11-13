-- Phase 3b: journal recurrence exceptions when their base series changes
-- collection.
--
-- Exceptions are separate DAV resources with their own hrefs. Moving the base
-- task only journals the base resource, leaving clients with phantom or
-- missing occurrence resources. Emit a tombstone for every live exception in
-- the old collection and an update for the new collection.
CREATE TRIGGER `tasks_caldav_move_exceptions`
AFTER UPDATE OF `list_id`, `caldav_href` ON `tasks`
WHEN (CASE
        WHEN OLD.`list_id` IS NULL THEN 'inbox'
        WHEN EXISTS (
          SELECT 1 FROM `lists` l
           WHERE l.`id` = OLD.`list_id` AND l.`is_inbox` = 1
             AND l.`user_id` = OLD.`user_id`
        ) THEN 'inbox'
        ELSE OLD.`list_id`
      END)
  <> (CASE
        WHEN NEW.`list_id` IS NULL THEN 'inbox'
        WHEN EXISTS (
          SELECT 1 FROM `lists` l
           WHERE l.`id` = NEW.`list_id` AND l.`is_inbox` = 1
             AND l.`user_id` = NEW.`user_id`
        ) THEN 'inbox'
        ELSE NEW.`list_id`
      END)
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`, `exception_id`)
	SELECT
	  CASE
	    WHEN OLD.`list_id` IS NULL THEN 'inbox'
	    WHEN EXISTS (
	      SELECT 1 FROM `lists` l
	       WHERE l.`id` = OLD.`list_id` AND l.`is_inbox` = 1
	         AND l.`user_id` = OLD.`user_id`
	    ) THEN 'inbox'
	    ELSE OLD.`list_id`
	  END,
	  OLD.`user_id`, OLD.`id`, e.`caldav_href`, 'delete', NEW.`updated_at`, e.`id`
	  FROM `task_recurrence_exceptions` e
	 WHERE e.`task_id` = OLD.`id` AND e.`deleted_at` IS NULL;
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
	  NEW.`user_id`, NEW.`id`, e.`caldav_href`, 'update', NEW.`updated_at`, e.`id`
	  FROM `task_recurrence_exceptions` e
	 WHERE e.`task_id` = NEW.`id` AND e.`deleted_at` IS NULL;
END;
