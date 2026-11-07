CREATE TABLE `installed_skill_packs` (
	`pack_id` text PRIMARY KEY NOT NULL,
	`installed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`prompt` text NOT NULL,
	`typed` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_skills_kind" CHECK("message_skills"."kind" IN ('builtin', 'custom', 'project'))
);
--> statement-breakpoint
CREATE INDEX `message_skills_session_idx` ON `message_skills` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `playbook_builtin_skills` (
	`playbook_id` text NOT NULL,
	`pack_id` text NOT NULL,
	`skill_name` text NOT NULL,
	PRIMARY KEY(`playbook_id`, `pack_id`, `skill_name`),
	FOREIGN KEY (`playbook_id`) REFERENCES `playbooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playbook_builtin_skills_pack_idx` ON `playbook_builtin_skills` (`pack_id`);
--> statement-breakpoint
-- A Custom Skill may not take a built-in skill's name: rename the ones that already do.
UPDATE `skills` SET `name` = `name` || '-custom' WHERE lower(`name`) IN ('caveman','caveman-commit','caveman-review','code-review','commit-message','grilling','humanizer','investigate-first','lean-build','migration','pr','refactor','retro','safe-refactor','ship','spec','surgical-patch','verify-and-stop') AND NOT EXISTS (SELECT 1 FROM `skills` AS `other` WHERE lower(`other`.`name`) = lower(`skills`.`name`) || '-custom');--> statement-breakpoint
UPDATE `skills` SET `name` = `name` || '-custom-2' WHERE lower(`name`) IN ('caveman','caveman-commit','caveman-review','code-review','commit-message','grilling','humanizer','investigate-first','lean-build','migration','pr','refactor','retro','safe-refactor','ship','spec','surgical-patch','verify-and-stop');
