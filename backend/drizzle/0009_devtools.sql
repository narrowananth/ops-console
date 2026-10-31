CREATE TABLE `session_connections` (
	`session_id` text NOT NULL,
	`connection_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `connection_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
