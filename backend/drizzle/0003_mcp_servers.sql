CREATE TABLE `disabled_mcp_servers` (
	`name` text PRIMARY KEY NOT NULL,
	`disabled_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `removed_mcp_servers` (
	`name` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`transport` text NOT NULL,
	`target` text NOT NULL,
	`removed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
) STRICT;
