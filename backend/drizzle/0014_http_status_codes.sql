ALTER TABLE `alerts` ADD `http_status` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `status_codes` text DEFAULT '[]' NOT NULL;