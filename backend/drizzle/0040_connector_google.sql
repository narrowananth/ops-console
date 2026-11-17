INSERT INTO `connectors` (`id`, `status`, `config`) VALUES ('google_docs', 'off', '{"client_id":""}') ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO `connectors` (`id`, `status`, `config`) VALUES ('google_sheets', 'off', '{"client_id":""}') ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO `connectors` (`id`, `status`, `config`) VALUES ('google_drive', 'off', '{"client_id":""}') ON CONFLICT DO NOTHING;
