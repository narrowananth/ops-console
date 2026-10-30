CREATE TABLE `alert_events` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "alert_events_data_json" CHECK(json_valid("alert_events"."data"))
);
--> statement-breakpoint
CREATE INDEX `alert_events_alert_idx` ON `alert_events` (`alert_id`,`at`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`route_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`source` text DEFAULT 'scan' NOT NULL,
	`severity` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`title` text NOT NULL,
	`log_line` text NOT NULL,
	`event_count` integer NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`resolved_at` text,
	`regression_count` integer DEFAULT 0 NOT NULL,
	`samples` text DEFAULT '[]' NOT NULL,
	`datadog_query` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`route_id`) REFERENCES `routes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "alerts_samples_json" CHECK(json_valid("alerts"."samples") AND json_type("alerts"."samples") = 'array' AND json_array_length("alerts"."samples") <= 25)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_fingerprint_unique` ON `alerts` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `alerts_status_idx` ON `alerts` (`status`,"last_seen_at" DESC);--> statement-breakpoint
CREATE INDEX `alerts_route_idx` ON `alerts` (`route_id`);--> statement-breakpoint
CREATE TABLE `fixes` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`session_id` text,
	`stage` text DEFAULT 'ticket' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`jira_key` text,
	`jira_url` text,
	`branch` text,
	`pr_number` integer,
	`pr_url` text,
	`error_message` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fixes_review_id_unique` ON `fixes` (`review_id`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`kind` text,
	`slug` text,
	`sdk_session_id` text,
	`steps` text DEFAULT '[]' NOT NULL,
	`replay` text,
	`root_cause` text,
	`proposed_fix` text,
	`diff` text,
	`markdown` text,
	`markdown_path` text,
	`error_message` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reports_steps_json" CHECK(json_valid("reports"."steps")),
	CONSTRAINT "reports_replay_json" CHECK("reports"."replay" IS NULL OR json_valid("reports"."replay")),
	CONSTRAINT "reports_diff_json" CHECK("reports"."diff" IS NULL OR json_valid("reports"."diff"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reports_one_running_idx` ON `reports` (`alert_id`) WHERE "reports"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX `reports_alert_version` ON `reports` (`alert_id`,`version`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`decision` text NOT NULL,
	`kind` text,
	`decided_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`undone_at` text,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reviews_kind_with_decision" CHECK(("reviews"."decision" = 'confirmed') = ("reviews"."kind" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_one_active_idx` ON `reviews` (`report_id`) WHERE "reviews"."undone_at" IS NULL;--> statement-breakpoint
CREATE TABLE `routes` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`ignored` integer DEFAULT false NOT NULL,
	`note` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "routes_ignored_bool" CHECK("routes"."ignored" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routes_service_method_path` ON `routes` (`service_id`,`method`,`path`);--> statement-breakpoint
CREATE TABLE `scan_route_results` (
	`scan_id` text NOT NULL,
	`route_id` text NOT NULL,
	`scanned_at` text NOT NULL,
	`error_count` integer NOT NULL,
	`state` text NOT NULL,
	PRIMARY KEY(`scan_id`, `route_id`),
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`route_id`) REFERENCES `routes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scan_route_results_route_idx` ON `scan_route_results` (`route_id`,"scanned_at" DESC);--> statement-breakpoint
CREATE TABLE `scans` (
	`id` text PRIMARY KEY NOT NULL,
	`triggered_by` text NOT NULL,
	`service_id` text,
	`window_size` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`error_code` text,
	`error_message` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scans_started_idx` ON `scans` ("started_at" DESC);--> statement-breakpoint
CREATE INDEX `scans_service_idx` ON `scans` (`service_id`,"started_at" DESC);--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`env` text NOT NULL,
	`repo_id` text,
	`check_interval` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `services_name_env` ON `services` (`name`,`env`);--> statement-breakpoint
ALTER TABLE `action_log` ADD `alert_id` text REFERENCES alerts(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `alert_id` text REFERENCES alerts(id) ON DELETE SET NULL;