UPDATE `sessions` SET `account_id` = NULL
	WHERE `account_id` IN (SELECT `id` FROM `claude_accounts` WHERE `config_dir` IS NULL);--> statement-breakpoint
UPDATE `settings`
	SET `value` = json_set(`value`, '$.active_account_id',
		(SELECT `id` FROM `claude_accounts` WHERE `config_dir` IS NOT NULL AND `signed_in` = 1 ORDER BY `position` LIMIT 1))
	WHERE `key` = 'agent_accounts'
		AND json_extract(`value`, '$.active_account_id') IN (SELECT `id` FROM `claude_accounts` WHERE `config_dir` IS NULL);--> statement-breakpoint
DELETE FROM `claude_accounts` WHERE `config_dir` IS NULL;
