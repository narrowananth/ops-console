CREATE TABLE `playbook_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text,
	`fix_id` text,
	`agent_review_id` text,
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
	CONSTRAINT "playbook_steps_status" CHECK("playbook_steps"."status" IN ('pending', 'running', 'done', 'skipped', 'failed')),
	CONSTRAINT "playbook_steps_one_job" CHECK(("playbook_steps"."report_id" IS NOT NULL) + ("playbook_steps"."fix_id" IS NOT NULL) + ("playbook_steps"."agent_review_id" IS NOT NULL) = 1),
	CONSTRAINT "playbook_steps_writes_bool" CHECK("playbook_steps"."writes" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_steps_report_idx` ON `playbook_steps` (`report_id`,`position`) WHERE "playbook_steps"."report_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_steps_fix_idx` ON `playbook_steps` (`fix_id`,`position`) WHERE "playbook_steps"."fix_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_steps_review_idx` ON `playbook_steps` (`agent_review_id`,`position`) WHERE "playbook_steps"."agent_review_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `playbook_triggers` (
	`trigger` text PRIMARY KEY NOT NULL,
	`playbook_id` text NOT NULL,
	FOREIGN KEY (`playbook_id`) REFERENCES `playbooks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "playbook_triggers_trigger" CHECK("playbook_triggers"."trigger" IN ('verify', 'fix', 'review_pr', 'thread_reply', 'session_message'))
);
--> statement-breakpoint
CREATE INDEX `playbook_triggers_playbook_idx` ON `playbook_triggers` (`playbook_id`);--> statement-breakpoint
CREATE TABLE `playbooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`rules` text DEFAULT '' NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "playbooks_steps_json" CHECK(json_valid("playbooks"."steps"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playbooks_name_idx` ON `playbooks` ("name" COLLATE NOCASE);--> statement-breakpoint
ALTER TABLE `fixes` ADD `playbook_id` text REFERENCES playbooks(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `fixes` ADD `playbook_name` text;--> statement-breakpoint
ALTER TABLE `fixes` ADD `playbook_rules` text;--> statement-breakpoint
ALTER TABLE `pr_agent_reviews` ADD `playbook_id` text REFERENCES playbooks(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `pr_agent_reviews` ADD `playbook_name` text;--> statement-breakpoint
ALTER TABLE `pr_agent_reviews` ADD `playbook_rules` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `playbook_id` text REFERENCES playbooks(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `playbook_name` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `playbook_rules` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `scratch_path` text;--> statement-breakpoint
INSERT INTO `playbook_steps` (`id`, `fix_id`, `position`, `title`, `instructions`, `writes`, `status`)
SELECT lower(hex(randomblob(16))), `id`, 0, 'Code',
  'Implement the proposed fix on the current branch. Keep the change small and add or update a test. Do not commit and do not push.',
  1,
  CASE `stage` WHEN 'code' THEN (CASE `status` WHEN 'failed' THEN 'failed' ELSE 'running' END)
    WHEN 'tests' THEN 'done' WHEN 'pr' THEN 'done' ELSE 'pending' END
FROM `fixes`;--> statement-breakpoint
INSERT INTO `playbook_steps` (`id`, `fix_id`, `position`, `title`, `instructions`, `writes`, `status`)
SELECT lower(hex(randomblob(16))), `id`, 1, 'Tests',
  'Run the tests in this Repo that cover the change, and fix what you broke. Answer failed when they still fail.',
  1,
  CASE `stage` WHEN 'tests' THEN (CASE `status` WHEN 'failed' THEN 'failed' ELSE 'running' END)
    WHEN 'pr' THEN 'done' ELSE 'pending' END
FROM `fixes`;--> statement-breakpoint
UPDATE `fixes` SET `stage` = 'steps' WHERE `stage` IN ('code', 'tests');--> statement-breakpoint
UPDATE `fixes` SET `playbook_name` = 'Fix (built-in)';
