ALTER TABLE `fixes` ADD `playbook_jira_ticket` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `playbooks` ADD `jira_ticket` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pr_agent_reviews` ADD `decision` text;--> statement-breakpoint
ALTER TABLE `pr_agent_reviews` ADD `base_branch` text;--> statement-breakpoint
ALTER TABLE `pr_agent_reviews` ADD `base_sha` text;--> statement-breakpoint
ALTER TABLE `pr_agent_reviews` ADD `report` text;--> statement-breakpoint
ALTER TABLE `pr_agent_reviews` ADD `error` text;