CREATE TABLE `provider_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`base_url` text,
	`models_json` text DEFAULT '[]' NOT NULL,
	`npm_pkg` text,
	`headers_json` text DEFAULT '{}' NOT NULL,
	`key_last4` text,
	`key_fingerprint` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_test_at` text,
	`last_test_ok` integer,
	`last_error` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "provider_credentials_kind_check" CHECK("provider_credentials"."kind" in ('preset','custom')),
	CONSTRAINT "provider_credentials_rev_check" CHECK("provider_credentials"."rev" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_credentials_provider_id_unique` ON `provider_credentials` (`provider_id`) WHERE "provider_credentials"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `provider_credentials_updated_idx` ON `provider_credentials` (`updated_at`);