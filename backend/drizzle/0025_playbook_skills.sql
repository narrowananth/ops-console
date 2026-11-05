CREATE TABLE `playbook_skills` (
	`playbook_id` text NOT NULL,
	`skill_id` text NOT NULL,
	PRIMARY KEY(`playbook_id`, `skill_id`),
	FOREIGN KEY (`playbook_id`) REFERENCES `playbooks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playbook_skills_skill_idx` ON `playbook_skills` (`skill_id`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`instructions` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_name_idx` ON `skills` ("name" COLLATE NOCASE);--> statement-breakpoint
ALTER TABLE `fixes` ADD `playbook_skills` text;--> statement-breakpoint
ALTER TABLE `pr_agent_reviews` ADD `playbook_skills` text;--> statement-breakpoint
ALTER TABLE `pr_comment_passes` ADD `playbook_skills` text;--> statement-breakpoint
ALTER TABLE `pr_reply_checks` ADD `playbook_skills` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `playbook_skills` text;