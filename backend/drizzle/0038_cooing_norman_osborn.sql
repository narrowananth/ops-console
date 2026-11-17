CREATE INDEX `action_log_connection_idx` ON `action_log` (`connection_id`);--> statement-breakpoint
CREATE INDEX `action_log_alert_idx` ON `action_log` (`alert_id`);--> statement-breakpoint
CREATE INDEX `approvals_session_idx` ON `approvals` (`session_id`);--> statement-breakpoint
CREATE INDEX `sessions_alert_idx` ON `sessions` (`alert_id`);