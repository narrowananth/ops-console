CREATE TABLE `health_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`target_id` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`latency_ms` integer,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `health_checks_target_idx` ON `health_checks` (`target`,`target_id`,`checked_at`);--> statement-breakpoint
CREATE INDEX `health_checks_checked_idx` ON `health_checks` (`checked_at`);--> statement-breakpoint
CREATE TABLE `run_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_started_at` text NOT NULL,
	`task_id` text NOT NULL,
	`parent_id` text,
	`type` text,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_agents_started_idx` ON `run_agents` (`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_agents_task` ON `run_agents` (`session_id`,`run_started_at`,`task_id`);--> statement-breakpoint
ALTER TABLE `claude_accounts` ADD `enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `run_usage` ADD `account_id` text;--> statement-breakpoint
ALTER TABLE `run_usage` ADD `purpose` text;--> statement-breakpoint
CREATE INDEX `run_usage_account_idx` ON `run_usage` (`account_id`,`finished_at`);--> statement-breakpoint
CREATE INDEX `run_steps_started_idx` ON `run_steps` (`started_at`);