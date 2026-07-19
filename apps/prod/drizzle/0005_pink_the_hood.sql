ALTER TABLE `tickets` ADD `number` integer;--> statement-breakpoint
WITH `ticket_numbers` AS (
	SELECT
		`id`,
		ROW_NUMBER() OVER (
			PARTITION BY `guild_id`
			ORDER BY `created_at`, `id`
		) AS `number`
	FROM `tickets`
)
UPDATE `tickets`
SET `number` = (
	SELECT `ticket_numbers`.`number`
	FROM `ticket_numbers`
	WHERE `ticket_numbers`.`id` = `tickets`.`id`
);--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_guild_number` ON `tickets` (`guild_id`,`number`);
