CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`description` text NOT NULL,
	`active` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_guild_normalized_name_unique` ON `labels` (`guild_id`,`normalized_name`);--> statement-breakpoint
CREATE INDEX `labels_guild_active` ON `labels` (`guild_id`,`active`);--> statement-breakpoint
CREATE TABLE `ticket_labels` (
	`ticket_id` text NOT NULL,
	`label_id` text NOT NULL,
	`applied_by_type` text NOT NULL,
	`applied_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`ticket_id`, `label_id`),
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `ticket_labels_label` ON `ticket_labels` (`label_id`);