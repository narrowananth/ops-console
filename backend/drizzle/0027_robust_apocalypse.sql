CREATE TABLE `run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_started_at` text NOT NULL,
	`agent_id` text,
	`tool` text NOT NULL,
	`summary` text NOT NULL,
	`phase` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`waited_ms` integer DEFAULT 0 NOT NULL,
	`ok` integer,
	`error` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_steps_session_idx` ON `run_steps` (`session_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `run_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`cost_usd` real NOT NULL,
	`tokens` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_usage_finished_idx` ON `run_usage` (`finished_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_usage_run` ON `run_usage` (`session_id`,`run_started_at`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `queued_text` text;