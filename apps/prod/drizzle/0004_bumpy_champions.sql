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
CREATE INDEX `reporter_hub_access_guild` ON `reporter_hub_access` (`guild_id`);