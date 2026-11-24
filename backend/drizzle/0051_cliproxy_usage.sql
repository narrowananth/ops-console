UPDATE `run_usage` SET `account_id` = 'cliproxy' WHERE `account_id` IS NULL AND EXISTS (SELECT 1 FROM `settings` WHERE `key` = 'cliproxy');
