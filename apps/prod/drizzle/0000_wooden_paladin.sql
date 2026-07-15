CREATE TABLE `protocord_permission_rule_events` (
	`id` text PRIMARY KEY NOT NULL,
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
CREATE INDEX `protocord_permission_rule_events_rule` ON `protocord_permission_rule_events` (`rule_id`,`created_at`);--> statement-breakpoint
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
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `protocord_permission_rules_identity` ON `protocord_permission_rules` (`guild_id`,`category_scope`,`channel_scope`,`subject_type`,`subject_id`,`object_type`,`object_id`,`verb`);--> statement-breakpoint
CREATE INDEX `protocord_permission_rules_context` ON `protocord_permission_rules` (`guild_id`,`category_id`,`channel_id`);