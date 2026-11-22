CREATE TABLE `processed_reporter_messages` (
	`ticket_id` text NOT NULL,
	`message_id` text NOT NULL,
	`claimed_at` text NOT NULL,
	PRIMARY KEY(`ticket_id`, `message_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ticket_assignee_suggestions` (
	`ticket_id` text NOT NULL,
	`user_id` text NOT NULL,
	`suggested_by` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`ticket_id`, `user_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ticket_triage_results` (
	`ticket_id` text PRIMARY KEY NOT NULL,
	`internal_summary` text NOT NULL,
	`reporter_summary` text NOT NULL,
	`completed_at` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
