CREATE TABLE `__new_services` (
	`id` text PRIMARY KEY NOT NULL,
	`connector` text DEFAULT 'datadog' NOT NULL,
	`name` text NOT NULL,
	`env` text NOT NULL,
	`repo_id` text,
	`repo_url` text,
	`check_interval` text,
	`code_looked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_services`("id", "connector", "name", "env", "repo_id", "repo_url", "check_interval", "code_looked_at", "created_at") SELECT "id", "connector", "name", "env", "repo_id", "repo_url", "check_interval", "code_looked_at", "created_at" FROM `services`;--> statement-breakpoint
DROP TABLE `services`;--> statement-breakpoint
ALTER TABLE `__new_services` RENAME TO `services`;--> statement-breakpoint
CREATE UNIQUE INDEX `services_connector_name_env` ON `services` (`connector`,`name`,`env`);--> statement-breakpoint
CREATE TABLE `__new_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`connector` text DEFAULT 'datadog' NOT NULL,
	`triggered_by` text NOT NULL,
	`service_id` text,
	`window_size` text NOT NULL,
	`envs` text DEFAULT '[]' NOT NULL,
	`services` text,
	`status_codes` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`error_code` text,
	`error_message` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_scans`("id", "connector", "triggered_by", "service_id", "window_size", "envs", "services", "status_codes", "status", "error_code", "error_message", "started_at", "finished_at") SELECT "id", "connector", "triggered_by", "service_id", "window_size", "envs", "services", "status_codes", "status", "error_code", "error_message", "started_at", "finished_at" FROM `scans`;--> statement-breakpoint
DROP TABLE `scans`;--> statement-breakpoint
ALTER TABLE `__new_scans` RENAME TO `scans`;--> statement-breakpoint
CREATE INDEX `scans_started_idx` ON `scans` ("started_at" DESC);--> statement-breakpoint
CREATE INDEX `scans_service_idx` ON `scans` (`service_id`,"started_at" DESC);--> statement-breakpoint
CREATE TABLE `__new_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`route_id` text NOT NULL,
	`connector` text DEFAULT 'datadog' NOT NULL,
	`fingerprint` text NOT NULL,
	`http_status` integer,
	`source` text DEFAULT 'scan' NOT NULL,
	`severity` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`title` text NOT NULL,
	`log_line` text NOT NULL,
	`event_count` integer NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`resolved_at` text,
	`cleared_at` text,
	`regression_count` integer DEFAULT 0 NOT NULL,
	`samples` text DEFAULT '[]' NOT NULL,
	`source_query` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`route_id`) REFERENCES `routes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "alerts_samples_json" CHECK(json_valid("__new_alerts"."samples") AND json_type("__new_alerts"."samples") = 'array' AND json_array_length("__new_alerts"."samples") <= 25)
);
--> statement-breakpoint
INSERT INTO `__new_alerts`("id", "route_id", "connector", "fingerprint", "http_status", "source", "severity", "status", "title", "log_line", "event_count", "first_seen_at", "last_seen_at", "resolved_at", "cleared_at", "regression_count", "samples", "source_query", "created_at", "updated_at") SELECT "id", "route_id", "connector", "fingerprint", "http_status", "source", "severity", "status", "title", "log_line", "event_count", "first_seen_at", "last_seen_at", "resolved_at", "cleared_at", "regression_count", "samples", "source_query", "created_at", "updated_at" FROM `alerts`;--> statement-breakpoint
DROP TABLE `alerts`;--> statement-breakpoint
ALTER TABLE `__new_alerts` RENAME TO `alerts`;--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_fingerprint_unique` ON `alerts` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `alerts_status_idx` ON `alerts` (`status`,"last_seen_at" DESC);--> statement-breakpoint
CREATE INDEX `alerts_route_idx` ON `alerts` (`route_id`);--> statement-breakpoint
INSERT INTO `connectors` (`id`, `status`, `config`) VALUES ('cloudwatch_logs', 'off', '{"profile":"","region":"","log_groups":[],"environments":["prod"],"daily_scan_time":"09:00","default_interval":"24h","rapid_errors_per_10m":100,"failing_errors_per_hour":5,"ignore":[],"reports_folder":"reports"}') ON CONFLICT DO NOTHING;
