CREATE TABLE `session_pull_requests` (
	`session_id` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`branch` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `number`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `session_pull_requests` (`session_id`, `number`, `url`, `branch`, `created_at`) SELECT `id`, `opened_pr_number`, `opened_pr_url`, `opened_pr_branch`, `created_at` FROM `sessions` WHERE `opened_pr_number` IS NOT NULL AND `opened_pr_url` IS NOT NULL AND `opened_pr_branch` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `opened_pr_number`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `opened_pr_url`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `opened_pr_branch`;
