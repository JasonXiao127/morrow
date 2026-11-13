-- Round 2 containment: workspace roles + scoped capture/CalDAV credentials.
ALTER TABLE `users` ADD `role` text DEFAULT 'member' NOT NULL CHECK (`role` in ('owner','member'));--> statement-breakpoint
UPDATE `users`
   SET `role` = 'owner'
 WHERE `id` = (
   SELECT `id` FROM `users` ORDER BY `created_at` ASC, `id` ASC LIMIT 1
 )
   AND NOT EXISTS (SELECT 1 FROM `users` WHERE `role` = 'owner');--> statement-breakpoint
ALTER TABLE `capture_tokens` ADD `kind` text DEFAULT 'capture' NOT NULL CHECK (`kind` in ('capture','caldav'));--> statement-breakpoint
CREATE INDEX `capture_tokens_kind_idx` ON `capture_tokens` (`user_id`, `kind`);
