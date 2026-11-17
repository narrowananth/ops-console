ALTER TABLE `services` ADD `code_looked_at` text;--> statement-breakpoint
CREATE INDEX `alert_events_at_idx` ON `alert_events` (`at`);--> statement-breakpoint
CREATE INDEX `fixes_session_idx` ON `fixes` (`session_id`);--> statement-breakpoint
CREATE INDEX `reviews_report_idx` ON `reviews` (`report_id`);--> statement-breakpoint
CREATE INDEX `run_steps_tool_idx` ON `run_steps` (`tool`,`started_at`);--> statement-breakpoint
CREATE INDEX `sessions_state_idx` ON `sessions` (`state`);--> statement-breakpoint
CREATE INDEX `sessions_run_outcome_idx` ON `sessions` (`run_outcome`);