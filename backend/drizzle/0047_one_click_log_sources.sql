UPDATE `connectors`
SET `status_detail` = CASE
      WHEN coalesce(json_extract(`config`, '$.url'), '') = '' OR json_extract(`config`, '$.url') GLOB 'https://*.grafana.net*'
        THEN 'Sign in again to use Grafana Cloud.'
      ELSE 'Loki on Grafana Cloud only: the self-hosted URL is no longer read.'
    END,
    `status` = 'auth',
    `account_label` = NULL
WHERE `id` = 'loki_logs' AND `status` <> 'off';--> statement-breakpoint
UPDATE `connectors`
SET `config` = json_set(json_remove(`config`, '$.url', '$.org_id', '$.auth', '$.username', '$.service_label', '$.env_label', '$.selector', '$.format'), '$.datasource_uid', '')
WHERE `id` = 'loki_logs';--> statement-breakpoint
UPDATE `connectors`
SET `status` = 'auth',
    `status_detail` = 'Sign in again to use the New Relic MCP server.',
    `account_label` = NULL
WHERE `id` = 'new_relic_logs' AND `status` <> 'off';--> statement-breakpoint
UPDATE `connectors`
SET `config` = json_remove(`config`, '$.service_attribute', '$.env_attribute', '$.filter')
WHERE `id` = 'new_relic_logs';
