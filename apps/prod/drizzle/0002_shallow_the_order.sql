CREATE TABLE `ticket_assignees` (
	`ticket_id` text NOT NULL,
	`assignee_user_id` text NOT NULL,
	`assigned_by_user_id` text NOT NULL,
	`method` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`ticket_id`, `assignee_user_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_assignees_assignee` ON `ticket_assignees` (`assignee_user_id`);