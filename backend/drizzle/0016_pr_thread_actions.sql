CREATE TABLE `pr_comment_passes` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`pr_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`branch` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`stage` text DEFAULT 'steps' NOT NULL,
	`commit_sha` text,
	`threads` text NOT NULL,
	`error` text,
	`can_retry` integer DEFAULT false NOT NULL,
	`scratch_path` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`playbook_id` text,
	`playbook_name` text,
	`playbook_rules` text,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`playbook_id`) REFERENCES `playbooks`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "pr_comment_passes_status" CHECK("pr_comment_passes"."status" IN ('running', 'ready', 'failed')),
	CONSTRAINT "pr_comment_passes_stage" CHECK("pr_comment_passes"."stage" IN ('steps', 'push', 'post')),
	CONSTRAINT "pr_comment_passes_threads_json" CHECK(json_valid("pr_comment_passes"."threads"))
);
--> statement-breakpoint
CREATE INDEX `pr_comment_passes_pr_idx` ON `pr_comment_passes` (`repo_id`,`pr_number`,"created_at" DESC);--> statement-breakpoint
CREATE TABLE `pr_reply_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`pr_number` integer NOT NULL,
	`comment_id` text NOT NULL,
	`head_sha` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`verdict` text,
	`reply` text,
	`reply_comment_id` text,
	`resolved` integer DEFAULT false NOT NULL,
	`error` text,
	`can_retry` integer DEFAULT false NOT NULL,
	`scratch_path` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`playbook_id` text,
	`playbook_name` text,
	`playbook_rules` text,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`playbook_id`) REFERENCES `playbooks`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "pr_reply_checks_status" CHECK("pr_reply_checks"."status" IN ('running', 'ready', 'failed')),
	CONSTRAINT "pr_reply_checks_verdict" CHECK("pr_reply_checks"."verdict" IN ('fixed', 'partly_fixed', 'not_fixed'))
);
--> statement-breakpoint
CREATE INDEX `pr_reply_checks_thread_idx` ON `pr_reply_checks` (`repo_id`,`pr_number`,`comment_id`,"created_at" DESC);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_playbook_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text,
	`fix_id` text,
	`agent_review_id` text,
	`reply_check_id` text,
	`comment_pass_id` text,
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
	FOREIGN KEY (`agent_review_id`) REFERENCES `pr_agent_reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reply_check_id`) REFERENCES `pr_reply_checks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`comment_pass_id`) REFERENCES `pr_comment_passes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "playbook_steps_status" CHECK("__new_playbook_steps"."status" IN ('pending', 'running', 'done', 'skipped', 'failed')),
	CONSTRAINT "playbook_steps_one_job" CHECK(("__new_playbook_steps"."report_id" IS NOT NULL) + ("__new_playbook_steps"."fix_id" IS NOT NULL) + ("__new_playbook_steps"."agent_review_id" IS NOT NULL) + ("__new_playbook_steps"."reply_check_id" IS NOT NULL) + ("__new_playbook_steps"."comment_pass_id" IS NOT NULL) = 1),
	CONSTRAINT "playbook_steps_writes_bool" CHECK("__new_playbook_steps"."writes" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_playbook_steps`("id", "report_id", "fix_id", "agent_review_id", "reply_check_id", "comment_pass_id", "position", "title", "instructions", "writes", "status", "summary", "started_at", "finished_at") SELECT "id", "report_id", "fix_id", "agent_review_id", NULL, NULL, "position", "title", "instructions", "writes", "status", "summary", "started_at", "finished_at" FROM `playbook_steps`;--> statement-breakpoint
DROP TABLE `playbook_steps`;--> statement-breakpoint
ALTER TABLE `__new_playbook_steps` RENAME TO `playbook_steps`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_steps_report_idx` ON `playbook_steps` (`report_id`,`position`) WHERE "playbook_steps"."report_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_steps_fix_idx` ON `playbook_steps` (`fix_id`,`position`) WHERE "playbook_steps"."fix_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_steps_review_idx` ON `playbook_steps` (`agent_review_id`,`position`) WHERE "playbook_steps"."agent_review_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_steps_reply_check_idx` ON `playbook_steps` (`reply_check_id`,`position`) WHERE "playbook_steps"."reply_check_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_steps_comment_pass_idx` ON `playbook_steps` (`comment_pass_id`,`position`) WHERE "playbook_steps"."comment_pass_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_playbook_triggers` (
	`trigger` text PRIMARY KEY NOT NULL,
	`playbook_id` text NOT NULL,
	FOREIGN KEY (`playbook_id`) REFERENCES `playbooks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "playbook_triggers_trigger" CHECK("__new_playbook_triggers"."trigger" IN ('verify', 'fix', 'review_pr', 'check_reply', 'address_comments', 'thread_reply', 'session_message'))
);
--> statement-breakpoint
INSERT INTO `__new_playbook_triggers`("trigger", "playbook_id") SELECT "trigger", "playbook_id" FROM `playbook_triggers`;--> statement-breakpoint
DROP TABLE `playbook_triggers`;--> statement-breakpoint
ALTER TABLE `__new_playbook_triggers` RENAME TO `playbook_triggers`;--> statement-breakpoint
CREATE INDEX `playbook_triggers_playbook_idx` ON `playbook_triggers` (`playbook_id`);