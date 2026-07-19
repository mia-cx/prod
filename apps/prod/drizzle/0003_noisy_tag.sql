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
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
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
CREATE INDEX `tickets_reporter_active` ON `tickets` (`guild_id`,`reporter_user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_thread` ON `tickets` (`thread_id`);
