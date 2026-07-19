CREATE TABLE `guild_label_taxonomies` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`seed_version` integer NOT NULL,
	`initialized_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `guild_settings` (
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`guild_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `guild_settings_guild` ON `guild_settings` (`guild_id`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_guild_normalized_name_unique` ON `labels` (`guild_id`,`normalized_name`);--> statement-breakpoint
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
CREATE INDEX `permission_rule_origins_source` ON `permission_rule_origins` (`guild_id`,`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `reporter_hub_access` (
	`guild_id` text NOT NULL,
	`hub_channel_id` text NOT NULL,
	`reporter_user_id` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`guild_id`, `hub_channel_id`, `reporter_user_id`)
);
--> statement-breakpoint
CREATE INDEX `reporter_hub_access_guild` ON `reporter_hub_access` (`guild_id`);--> statement-breakpoint
CREATE TABLE `ticket_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`event_type` text NOT NULL,
	`details_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_events_id_unique` ON `ticket_events` (`id`);--> statement-breakpoint
CREATE INDEX `ticket_events_ticket_sequence` ON `ticket_events` (`ticket_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `ticket_events_guild` ON `ticket_events` (`guild_id`);--> statement-breakpoint
CREATE TABLE `ticket_labels` (
	`ticket_id` text NOT NULL,
	`label_id` text NOT NULL,
	`applied_by_type` text NOT NULL,
	`applied_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`ticket_id`, `label_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_labels_label` ON `ticket_labels` (`label_id`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`guild_id` text NOT NULL,
	`hub_channel_id` text NOT NULL,
	`reporter_user_id` text NOT NULL,
	`originating_alias` text NOT NULL,
	`status` text NOT NULL,
	`triage_status` text NOT NULL,
	`summary` text,
	`thread_id` text,
	`opening_message_id` text,
	`failure_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tickets_status` ON `tickets` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_guild_number` ON `tickets` (`guild_id`,`number`);--> statement-breakpoint
CREATE INDEX `tickets_reporter_active` ON `tickets` (`guild_id`,`reporter_user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_thread` ON `tickets` (`thread_id`);--> statement-breakpoint
CREATE TABLE `protocord_permission_rule_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`guild_id` text NOT NULL,
	`category_id` text,
	`channel_id` text,
	`rule_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocord_permission_rule_events_id` ON `protocord_permission_rule_events` (`id`);--> statement-breakpoint
CREATE INDEX `protocord_permission_rule_events_rule` ON `protocord_permission_rule_events` (`rule_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `protocord_permission_rule_events_context` ON `protocord_permission_rule_events` (`guild_id`,`category_id`,`channel_id`);--> statement-breakpoint
CREATE TABLE `protocord_permission_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`category_id` text,
	`channel_id` text,
	`category_scope` text GENERATED ALWAYS AS (coalesce(category_id, '')) VIRTUAL NOT NULL,
	`channel_scope` text GENERATED ALWAYS AS (coalesce(channel_id, '')) VIRTUAL NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`verb` text NOT NULL,
	`permit` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocord_permission_rules_identity` ON `protocord_permission_rules` (`guild_id`,`category_scope`,`channel_scope`,`subject_type`,`subject_id`,`object_type`,`object_id`,`verb`);--> statement-breakpoint
CREATE INDEX `protocord_permission_rules_context` ON `protocord_permission_rules` (`guild_id`,`category_id`,`channel_id`,`active`);