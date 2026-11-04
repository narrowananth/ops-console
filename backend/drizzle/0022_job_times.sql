ALTER TABLE `pr_agent_reviews` ADD `started_at` text;--> statement-breakpoint
ALTER TABLE `pr_agent_reviews` ADD `finished_at` text;--> statement-breakpoint
ALTER TABLE `pr_comment_passes` ADD `started_at` text;--> statement-breakpoint
ALTER TABLE `pr_comment_passes` ADD `finished_at` text;--> statement-breakpoint
ALTER TABLE `pr_reply_checks` ADD `started_at` text;--> statement-breakpoint
ALTER TABLE `pr_reply_checks` ADD `finished_at` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `started_at` text;