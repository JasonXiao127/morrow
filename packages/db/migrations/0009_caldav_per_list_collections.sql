-- Phase 2b: per-list CalDAV collections.
--
-- The journal now records the collection a change belongs to: `inbox` for
-- unlisted/inbox tasks, otherwise the list id. The legacy flat collection
-- keeps working because its sync query scopes by user_id, not collection.
DROP TRIGGER IF EXISTS `tasks_caldav_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_caldav_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_caldav_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `task_tags_caldav_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `task_tags_caldav_delete`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `tags_caldav_update`;--> statement-breakpoint
UPDATE `caldav_changes`
   SET `collection` = (
     SELECT CASE
       WHEN t.`list_id` IS NULL THEN 'inbox'
       WHEN EXISTS (
         SELECT 1 FROM `lists` l
          WHERE l.`id` = t.`list_id` AND l.`is_inbox` = 1
            AND l.`user_id` = t.`user_id`
       ) THEN 'inbox'
       ELSE t.`list_id`
     END
     FROM `tasks` t WHERE t.`id` = `caldav_changes`.`task_id`
   )
 WHERE `collection` = 'morrow'
   AND EXISTS (SELECT 1 FROM `tasks` t WHERE t.`id` = `caldav_changes`.`task_id`);--> statement-breakpoint
CREATE INDEX `caldav_changes_collection_seq_idx` ON `caldav_changes` (`collection`, `seq`);--> statement-breakpoint
CREATE TRIGGER `tasks_caldav_insert`
AFTER INSERT ON `tasks`
BEGIN
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`)
	VALUES (
	  CASE
	    WHEN NEW.`list_id` IS NULL THEN 'inbox'
	    WHEN EXISTS (
	      SELECT 1 FROM `lists` l
	       WHERE l.`id` = NEW.`list_id` AND l.`is_inbox` = 1
	         AND l.`user_id` = NEW.`user_id`
	    ) THEN 'inbox'
	    ELSE NEW.`list_id`
	  END,
	  NEW.`user_id`, NEW.`id`,
	  COALESCE(NEW.`caldav_href`, NEW.`id` || '.ics'), 'create', NEW.`created_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_caldav_update`
AFTER UPDATE ON `tasks`
BEGIN
	-- If the task moved between collections (list changed, or inbox mapping
	-- changed), emit a tombstone for the old collection first.
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`)
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
	  OLD.`user_id`, OLD.`id`,
	  COALESCE(OLD.`caldav_href`, OLD.`id` || '.ics'), 'delete', NEW.`updated_at`
	 WHERE (CASE
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
	    OR COALESCE(OLD.`caldav_href`, OLD.`id` || '.ics')
	       IS NOT COALESCE(NEW.`caldav_href`, NEW.`id` || '.ics');
	INSERT INTO `caldav_changes` (`collection`, `user_id`, `task_id`, `href`, `change_type`, `changed_at`)
	VALUES (
	  CASE
	    WHEN NEW.`list_id` IS NULL THEN 'inbox'
	    WHEN EXISTS (
	      SELECT 1 FROM `lists` l
	       WHERE l.`id` = NEW.`list_id` AND l.`is_inbox` = 1
	         AND l.`user_id` = NEW.`user_id`
	    ) THEN 'inbox'
	    ELSE NEW.`list_id`
	  END,
	  NEW.`user_id`, NEW.`id`,
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
	VALUES (
	  CASE
	    WHEN OLD.`list_id` IS NULL THEN 'inbox'
	    WHEN EXISTS (
	      SELECT 1 FROM `lists` l
	       WHERE l.`id` = OLD.`list_id` AND l.`is_inbox` = 1
	         AND l.`user_id` = OLD.`user_id`
	    ) THEN 'inbox'
	    ELSE OLD.`list_id`
	  END,
	  OLD.`user_id`, OLD.`id`,
	  COALESCE(OLD.`caldav_href`, OLD.`id` || '.ics'), 'delete', OLD.`updated_at`);
END;
--> statement-breakpoint
CREATE TRIGGER `task_tags_caldav_insert`
AFTER INSERT ON `task_tags`
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
	  COALESCE(t.`caldav_href`, t.`id` || '.ics'), 'update', t.`updated_at`
	  FROM `tasks` t WHERE t.`id` = NEW.`task_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `task_tags_caldav_delete`
AFTER DELETE ON `task_tags`
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
	  COALESCE(t.`caldav_href`, t.`id` || '.ics'), 'update', t.`updated_at`
	  FROM `tasks` t WHERE t.`id` = OLD.`task_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `tags_caldav_update`
AFTER UPDATE OF `name`, `deleted_at` ON `tags`
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
	  COALESCE(t.`caldav_href`, t.`id` || '.ics'), 'update', NEW.`updated_at`
	  FROM `task_tags` tt
	  JOIN `tasks` t ON t.`id` = tt.`task_id`
	 WHERE tt.`tag_id` = NEW.`id`;
END;
