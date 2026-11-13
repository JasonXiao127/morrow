-- Round 4: stable CalDAV task identity + client-chosen resource paths.
ALTER TABLE `tasks` ADD `ical_uid` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `caldav_href` text;--> statement-breakpoint
-- Deterministic backfill keeps existing tasks addressable before the first
-- CalDAV write. New rows may keep NULL until their first CalDAV PUT; the
-- serializer/routes use the same `<id>@morrow` / `<id>.ics` fallbacks.
UPDATE `tasks` SET `ical_uid` = `id` || '@morrow' WHERE `ical_uid` IS NULL;--> statement-breakpoint
UPDATE `tasks` SET `caldav_href` = `id` || '.ics' WHERE `caldav_href` IS NULL;--> statement-breakpoint
-- UID uniqueness is per collection/user, not global. Soft-deleted rows are
-- excluded so their identity can be reused after DELETE.
CREATE UNIQUE INDEX `tasks_user_ical_uid_unique` ON `tasks` (`user_id`, `ical_uid`) WHERE `ical_uid` IS NOT NULL AND `deleted_at` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_user_caldav_href_unique` ON `tasks` (`user_id`, `caldav_href`) WHERE `caldav_href` IS NOT NULL AND `deleted_at` IS NULL;
