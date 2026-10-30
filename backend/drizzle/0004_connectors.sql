CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'off' NOT NULL,
	`status_detail` text,
	`account_label` text,
	`login` text,
	`config` text DEFAULT '{}' NOT NULL,
	`last_checked_at` text,
	CONSTRAINT "connectors_config_json" CHECK(json_valid("connectors"."config"))
) STRICT;
--> statement-breakpoint
INSERT INTO `connectors` (`id`, `status`, `config`) VALUES
	('datadog', 'off', '{"site":"datadoghq.com","environments":["prod"],"daily_scan_time":"09:00","default_interval":"24h","rapid_errors_per_10m":100,"failing_errors_per_hour":5,"ignore":[],"reports_folder":"reports"}'),
	('jira', 'off', '{"site":"","project_key":"","issue_types":{"bug":"Bug","improvement":"Improvement"},"in_review_status":"In Review","create_tickets":true}'),
	('github', 'off', '{"org":null}'),
	('gitlab', 'off', '{"host":"gitlab.com"}'),
	('bitbucket', 'off', '{"workspace":"","ssh_key_path":"~/.ssh/id_ed25519","pr_target_branch":"main"}'),
	('slack', 'off', '{"workspace":"","alert_channel":"","review_dm_to":""}'),
	('sentry', 'off', '{"org":null}');
