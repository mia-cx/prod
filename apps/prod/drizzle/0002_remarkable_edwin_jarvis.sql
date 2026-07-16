CREATE TABLE `guild_settings` (
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`guild_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `guild_settings_guild` ON `guild_settings` (`guild_id`);