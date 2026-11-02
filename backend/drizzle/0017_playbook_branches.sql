ALTER TABLE `fixes` ADD `playbook_branches` text;--> statement-breakpoint
ALTER TABLE `playbooks` ADD `branches` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `playbook_branches` text;