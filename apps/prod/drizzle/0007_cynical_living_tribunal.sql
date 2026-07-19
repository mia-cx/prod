CREATE TABLE `permission_rule_origin_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`guild_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`verb` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`before_permit` text,
	`after_permit` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permission_rule_origin_events_id` ON `permission_rule_origin_events` (`id`);--> statement-breakpoint
CREATE INDEX `permission_rule_origin_events_guild` ON `permission_rule_origin_events` (`guild_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `permission_rule_origins` (
	`guild_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`verb` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`permit` text NOT NULL,
	PRIMARY KEY(`guild_id`, `subject_type`, `subject_id`, `object_type`, `object_id`, `verb`, `source_type`, `source_id`)
);
--> statement-breakpoint
CREATE INDEX `permission_rule_origins_guild` ON `permission_rule_origins` (`guild_id`);--> statement-breakpoint
CREATE INDEX `permission_rule_origins_source` ON `permission_rule_origins` (`guild_id`,`source_type`,`source_id`);