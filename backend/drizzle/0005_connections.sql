CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`env` text NOT NULL,
	`access` text DEFAULT 'read' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'off' NOT NULL,
	`status_detail` text,
	`latency_ms` integer,
	`last_checked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "connections_config_json" CHECK(json_valid("connections"."config"))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_name_unique` ON `connections` (`name`);--> statement-breakpoint
ALTER TABLE `action_log` ADD `connection_id` text REFERENCES connections(id) ON DELETE SET NULL;