ALTER TABLE `services` ADD `connector` text DEFAULT 'datadog' NOT NULL CONSTRAINT "services_connector_known" CHECK(`connector` IN ('datadog', 'otel_logs'));--> statement-breakpoint
DROP INDEX `services_name_env`;--> statement-breakpoint
CREATE UNIQUE INDEX `services_connector_name_env` ON `services` (`connector`,`name`,`env`);--> statement-breakpoint
ALTER TABLE `scans` ADD `connector` text DEFAULT 'datadog' NOT NULL CONSTRAINT "scans_connector_known" CHECK(`connector` IN ('datadog', 'otel_logs'));--> statement-breakpoint
ALTER TABLE `alerts` ADD `connector` text DEFAULT 'datadog' NOT NULL CONSTRAINT "alerts_connector_known" CHECK(`connector` IN ('datadog', 'otel_logs'));--> statement-breakpoint
ALTER TABLE `alerts` RENAME COLUMN `datadog_query` TO `source_query`;--> statement-breakpoint
INSERT INTO `connectors` (`id`, `status`, `config`) VALUES ('otel_logs', 'off', '{"folder":"","environments":["prod"],"daily_scan_time":"09:00","default_interval":"24h","rapid_errors_per_10m":100,"failing_errors_per_hour":5,"ignore":[],"reports_folder":"reports"}') ON CONFLICT DO NOTHING;
