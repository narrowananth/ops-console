CREATE TABLE `pr_agent_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`pr_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`verdict` text,
	`findings` text DEFAULT '[]' NOT NULL,
	`checklist` text DEFAULT '[]' NOT NULL,
	`tools` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pr_agent_reviews_findings_json" CHECK(json_valid("pr_agent_reviews"."findings")),
	CONSTRAINT "pr_agent_reviews_checklist_json" CHECK(json_valid("pr_agent_reviews"."checklist")),
	CONSTRAINT "pr_agent_reviews_tools_json" CHECK(json_valid("pr_agent_reviews"."tools"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `agent_comments` (
	`repo_id` text NOT NULL,
	`pr_number` integer NOT NULL,
	`comment_id` text NOT NULL,
	`agent_review_id` text,
	`posted_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`repo_id`, `pr_number`, `comment_id`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_review_id`) REFERENCES `pr_agent_reviews`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE INDEX `pr_agent_reviews_pr_idx` ON `pr_agent_reviews` (`repo_id`,`pr_number`,"created_at" DESC);--> statement-breakpoint
ALTER TABLE `sessions` ADD `repo_id` text REFERENCES repos(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `sessions` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `pr_number` integer;--> statement-breakpoint
CREATE INDEX `sessions_repo_idx` ON `sessions` (`repo_id`,"last_active_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_one_pr_review_idx` ON `sessions` (`repo_id`,`pr_number`) WHERE "sessions"."kind" = 'pr_review';