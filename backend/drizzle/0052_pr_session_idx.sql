DROP INDEX `sessions_one_open_pr_action_idx`;--> statement-breakpoint
CREATE INDEX `sessions_pr_session_idx` ON `sessions` (`repo_id`,`pr_number`) WHERE "sessions"."pr_action" IS NOT NULL;