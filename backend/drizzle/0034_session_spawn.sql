ALTER TABLE `sessions` ADD `spawned_by_session_id` text REFERENCES sessions(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `sessions` ADD `spawn_call_id` text;--> statement-breakpoint
CREATE INDEX `sessions_spawned_by_idx` ON `sessions` (`spawned_by_session_id`);