-- Past jobs are not kept: their rows go, with the steps and the comment links that pointed at them.
DELETE FROM `playbook_steps` WHERE `report_id` IS NULL AND `fix_id` IS NULL;--> statement-breakpoint
UPDATE `agent_comments` SET `agent_review_id` = NULL;--> statement-breakpoint
DROP TABLE `pr_comment_passes`;--> statement-breakpoint
DROP TABLE `pr_reply_checks`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_playbook_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text,
	`fix_id` text,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`instructions` text NOT NULL,
	`writes` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`summary` text,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fix_id`) REFERENCES `fixes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "playbook_steps_status" CHECK("__new_playbook_steps"."status" IN ('pending', 'running', 'done', 'skipped', 'failed')),
	CONSTRAINT "playbook_steps_one_job" CHECK(("__new_playbook_steps"."report_id" IS NOT NULL) + ("__new_playbook_steps"."fix_id" IS NOT NULL) = 1),
	CONSTRAINT "playbook_steps_writes_bool" CHECK("__new_playbook_steps"."writes" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_playbook_steps`("id", "report_id", "fix_id", "position", "title", "instructions", "writes", "status", "summary", "started_at", "finished_at") SELECT "id", "report_id", "fix_id", "position", "title", "instructions", "writes", "status", "summary", "started_at", "finished_at" FROM `playbook_steps`;--> statement-breakpoint
DROP TABLE `playbook_steps`;--> statement-breakpoint
ALTER TABLE `__new_playbook_steps` RENAME TO `playbook_steps`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_steps_report_idx` ON `playbook_steps` (`report_id`,`position`) WHERE "playbook_steps"."report_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_steps_fix_idx` ON `playbook_steps` (`fix_id`,`position`) WHERE "playbook_steps"."fix_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_pr_agent_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`pr_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`session_id` text,
	`decision` text,
	`verdict` text,
	`base_branch` text,
	`base_sha` text,
	`note` text,
	`report` text,
	`findings` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "pr_agent_reviews_findings_json" CHECK(json_valid("__new_pr_agent_reviews"."findings"))
);
--> statement-breakpoint
DROP TABLE `pr_agent_reviews`;--> statement-breakpoint
ALTER TABLE `__new_pr_agent_reviews` RENAME TO `pr_agent_reviews`;--> statement-breakpoint
CREATE INDEX `pr_agent_reviews_pr_idx` ON `pr_agent_reviews` (`repo_id`,`pr_number`,"created_at" DESC);--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`access_mode` text NOT NULL,
	`account_id` text,
	`sdk_session_id` text,
	`repo_id` text,
	`branch` text,
	`pr_number` integer,
	`pr_action` text,
	`pr_action_head_sha` text,
	`pr_action_threads` text,
	`pr_action_commit_sha` text,
	`pr_action_submitted_at` text,
	`extra_repo_ids` text,
	`trusted_clis` text,
	`alert_id` text,
	`state` text DEFAULT 'idle' NOT NULL,
	`last_message_preview` text,
	`run_started_at` text,
	`run_finished_at` text,
	`run_outcome` text,
	`run_subagents` text,
	`run_blocked_hosts` text,
	`run_limit_since` text,
	`run_limit_resets_at` text,
	`queued_text` text,
	`spawned_by_session_id` text,
	`spawn_call_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_active_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `claude_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`spawned_by_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sessions_pr_action" CHECK("__new_sessions"."pr_action" IN ('address_comments', 'check_replies', 'review')),
	CONSTRAINT "sessions_pr_action_threads_json" CHECK("__new_sessions"."pr_action_threads" IS NULL OR json_valid("__new_sessions"."pr_action_threads"))
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "kind", "title", "model", "effort", "access_mode", "account_id", "sdk_session_id", "repo_id", "branch", "pr_number", "extra_repo_ids", "trusted_clis", "alert_id", "state", "last_message_preview", "run_started_at", "run_finished_at", "run_outcome", "run_subagents", "run_blocked_hosts", "run_limit_since", "run_limit_resets_at", "queued_text", "spawned_by_session_id", "spawn_call_id", "created_at", "last_active_at") SELECT "id", "kind", "title", "model", "effort", "access_mode", "account_id", "sdk_session_id", "repo_id", "branch", "pr_number", "extra_repo_ids", "trusted_clis", "alert_id", "state", "last_message_preview", "run_started_at", "run_finished_at", "run_outcome", "run_subagents", "run_blocked_hosts", "run_limit_since", "run_limit_resets_at", "queued_text", "spawned_by_session_id", "spawn_call_id", "created_at", "last_active_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
CREATE INDEX `sessions_spawned_by_idx` ON `sessions` (`spawned_by_session_id`);--> statement-breakpoint
CREATE INDEX `sessions_alert_idx` ON `sessions` (`alert_id`);--> statement-breakpoint
CREATE INDEX `sessions_state_idx` ON `sessions` (`state`);--> statement-breakpoint
CREATE INDEX `sessions_run_outcome_idx` ON `sessions` (`run_outcome`);--> statement-breakpoint
CREATE INDEX `sessions_active_idx` ON `sessions` ("last_active_at" DESC);--> statement-breakpoint
CREATE INDEX `sessions_repo_idx` ON `sessions` (`repo_id`,"last_active_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_one_open_pr_action_idx` ON `sessions` (`repo_id`,`pr_number`,`pr_action`) WHERE "sessions"."pr_action" IS NOT NULL AND "sessions"."pr_action_submitted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_one_pr_review_idx` ON `sessions` (`repo_id`,`pr_number`) WHERE "sessions"."kind" = 'pr_review';