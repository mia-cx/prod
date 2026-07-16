PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_protocord_permission_rule_events` (
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
INSERT INTO `__new_protocord_permission_rule_events`("id", "guild_id", "category_id", "channel_id", "rule_id", "event_type", "actor_user_id", "before_json", "after_json", "created_at") SELECT "id", "guild_id", "category_id", "channel_id", "rule_id", "event_type", "actor_user_id", "before_json", "after_json", "created_at" FROM `protocord_permission_rule_events` ORDER BY rowid;--> statement-breakpoint
DROP TABLE `protocord_permission_rule_events`;--> statement-breakpoint
ALTER TABLE `__new_protocord_permission_rule_events` RENAME TO `protocord_permission_rule_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `protocord_permission_rule_events_id` ON `protocord_permission_rule_events` (`id`);--> statement-breakpoint
CREATE INDEX `protocord_permission_rule_events_rule` ON `protocord_permission_rule_events` (`rule_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `protocord_permission_rule_events_context` ON `protocord_permission_rule_events` (`guild_id`,`category_id`,`channel_id`);
