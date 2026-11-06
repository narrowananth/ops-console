ALTER TABLE `run_usage` ADD `breakdown` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `run_limit_since` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `run_limit_resets_at` text;