-- Phase 2c: per-collection UID/href uniqueness.
--
-- A resource identity is unique within its CalDAV collection, not across the
-- whole user account. The collection scope is the list id for listed tasks and
-- the user id for unlisted/inbox tasks (there is one virtual Inbox per user).
--
-- Existing data can violate the wider shared-list scope when two members put
-- the same UID/href in one shared list under the old per-user index. Repair
-- deterministically (oldest row keeps the identity) before swapping indexes.
UPDATE `tasks`
   SET `ical_uid` = `ical_uid` || '~' || `id`
 WHERE `ical_uid` IS NOT NULL AND `deleted_at` IS NULL
   AND `id` IN (
     SELECT `id` FROM (
       SELECT `id`,
              ROW_NUMBER() OVER (
                PARTITION BY COALESCE(`list_id`, `user_id`), `ical_uid`
                ORDER BY `created_at` ASC, `id` ASC
              ) AS `rn`
         FROM `tasks`
        WHERE `ical_uid` IS NOT NULL AND `deleted_at` IS NULL
     )
     WHERE `rn` > 1
   );--> statement-breakpoint
UPDATE `tasks`
   SET `caldav_href` = `caldav_href` || '~' || `id`
 WHERE `caldav_href` IS NOT NULL AND `deleted_at` IS NULL
   AND `id` IN (
     SELECT `id` FROM (
       SELECT `id`,
              ROW_NUMBER() OVER (
                PARTITION BY COALESCE(`list_id`, `user_id`), `caldav_href`
                ORDER BY `created_at` ASC, `id` ASC
              ) AS `rn`
         FROM `tasks`
        WHERE `caldav_href` IS NOT NULL AND `deleted_at` IS NULL
     )
     WHERE `rn` > 1
   );--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_user_ical_uid_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_user_caldav_href_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_collection_ical_uid_unique`
  ON `tasks` (COALESCE(`list_id`, `user_id`), `ical_uid`)
  WHERE `ical_uid` IS NOT NULL AND `deleted_at` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_collection_caldav_href_unique`
  ON `tasks` (COALESCE(`list_id`, `user_id`), `caldav_href`)
  WHERE `caldav_href` IS NOT NULL AND `deleted_at` IS NULL;
