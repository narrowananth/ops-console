CREATE TABLE `claude_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`config_dir` text,
	`position` integer NOT NULL,
	`signed_in` integer DEFAULT 0 NOT NULL,
	`email` text,
	`plan` text,
	`five_hour_pct` real,
	`five_hour_resets_at` text,
	`weekly_pct` real,
	`weekly_resets_at` text,
	`usage_seen_at` text,
	`last_checked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "claude_accounts_signed_in_bool" CHECK("claude_accounts"."signed_in" IN (0, 1))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `claude_accounts_config_dir_idx` ON `claude_accounts` (ifnull("config_dir", ''));--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`access_mode` text NOT NULL,
	`account_id` text,
	`sdk_session_id` text,
	`state` text DEFAULT 'idle' NOT NULL,
	`last_message_preview` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_active_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `claude_accounts`(`id`) ON UPDATE no action ON DELETE restrict
) STRICT;
--> statement-breakpoint
CREATE INDEX `sessions_active_idx` ON `sessions` ("last_active_at" DESC);--> statement-breakpoint
CREATE TABLE `action_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`session_id` text,
	`target` text NOT NULL,
	`command` text NOT NULL,
	`is_prod` integer DEFAULT 0 NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`finished_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "action_log_is_prod_bool" CHECK("action_log"."is_prod" IN (0, 1))
) STRICT;
--> statement-breakpoint
CREATE INDEX `action_log_at_idx` ON `action_log` ("at" DESC);--> statement-breakpoint
CREATE INDEX `action_log_session_idx` ON `action_log` (`session_id`,`at`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`action_log_id` text,
	`session_id` text,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`action_log_id`) REFERENCES `action_log`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_action_log_id_unique` ON `approvals` (`action_log_id`);--> statement-breakpoint
CREATE INDEX `approvals_pending_idx` ON `approvals` (`requested_at`) WHERE "approvals"."status" = 'pending';--> statement-breakpoint
INSERT INTO `claude_accounts` (`id`, `label`, `config_dir`, `position`) VALUES (
	lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-'
		|| substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	'default', NULL, 1
);--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`) VALUES
	('session_defaults', '{"model":"claude-sonnet-5-5","effort":"high","access_mode":"supervised"}');--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`)
	SELECT 'agent_accounts', json_object('active_account_id', `id`, 'auto_switch', json('true'), 'threshold', 95, 'smart_usage', json('true'))
	FROM `claude_accounts` WHERE `config_dir` IS NULL;
