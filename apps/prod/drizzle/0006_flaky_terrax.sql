CREATE TABLE `__new_tickets` (
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
CREATE TABLE `__new_ticket_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`event_type` text NOT NULL,
	`details_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `__new_tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_tickets`("id", "number", "guild_id", "hub_channel_id", "reporter_user_id", "originating_alias", "status", "triage_status", "summary", "thread_id", "opening_message_id", "failure_reason", "created_at", "updated_at") SELECT "id", "number", "guild_id", "hub_channel_id", "reporter_user_id", "originating_alias", "status", "triage_status", "summary", "thread_id", "opening_message_id", "failure_reason", "created_at", "updated_at" FROM `tickets`;--> statement-breakpoint
INSERT INTO `__new_ticket_events`("sequence", "id", "ticket_id", "guild_id", "event_type", "details_json", "created_at") SELECT "sequence", "id", "ticket_id", "guild_id", "event_type", "details_json", "created_at" FROM `ticket_events`;--> statement-breakpoint
DROP TABLE `ticket_events`;--> statement-breakpoint
DROP TABLE `tickets`;--> statement-breakpoint
ALTER TABLE `__new_tickets` RENAME TO `tickets`;--> statement-breakpoint
ALTER TABLE `__new_ticket_events` RENAME TO `ticket_events`;--> statement-breakpoint
CREATE INDEX `tickets_status` ON `tickets` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_guild_number` ON `tickets` (`guild_id`,`number`);--> statement-breakpoint
CREATE INDEX `tickets_reporter_active` ON `tickets` (`guild_id`,`reporter_user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_thread` ON `tickets` (`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_events_id_unique` ON `ticket_events` (`id`);--> statement-breakpoint
CREATE INDEX `ticket_events_ticket_sequence` ON `ticket_events` (`ticket_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `ticket_events_guild` ON `ticket_events` (`guild_id`);
