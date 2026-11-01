ALTER TABLE `alerts` ADD `cleared_at` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `envs` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `repo_url` text;--> statement-breakpoint
UPDATE `alerts` SET `severity` = CASE `severity` WHEN 'sev2' THEN 'high' WHEN 'sev3' THEN 'medium' ELSE 'low' END;
