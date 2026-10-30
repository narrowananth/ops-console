import { z } from 'zod';
import { HealthStatus, McpTransport } from './mcp';

/** In the fixed order the list returns them. */
export enum ConnectorId {
  Datadog = 'datadog',
  Jira = 'jira',
  Github = 'github',
  Gitlab = 'gitlab',
  Bitbucket = 'bitbucket',
  Slack = 'slack',
  Sentry = 'sentry',
}

export const CONNECTOR_ORDER: ConnectorId[] = Object.values(ConnectorId);

export const CONNECTOR_NAMES: Record<ConnectorId, string> = {
  [ConnectorId.Datadog]: 'Datadog',
  [ConnectorId.Jira]: 'Jira',
  [ConnectorId.Github]: 'GitHub',
  [ConnectorId.Gitlab]: 'GitLab',
  [ConnectorId.Bitbucket]: 'Bitbucket',
  [ConnectorId.Slack]: 'Slack',
  [ConnectorId.Sentry]: 'Sentry',
};

/** How the console reaches the service (ADR 0005). */
export const CONNECTOR_VIA: Record<ConnectorId, string> = {
  [ConnectorId.Datadog]: 'pup CLI + datadog-pup MCP',
  [ConnectorId.Jira]: 'Atlassian MCP',
  [ConnectorId.Github]: 'gh CLI',
  [ConnectorId.Gitlab]: 'glab CLI',
  [ConnectorId.Bitbucket]: 'git over SSH + Bitbucket API',
  [ConnectorId.Slack]: 'Slack MCP',
  [ConnectorId.Sentry]: 'Sentry MCP',
};

/** The MCP Server each Connector rides on or registers. */
export const CONNECTOR_SERVERS: Partial<
  Record<ConnectorId, { name: string; transport: McpTransport; target: string }>
> = {
  [ConnectorId.Datadog]: { name: 'datadog-pup', transport: McpTransport.Stdio, target: 'pup mcp serve' },
  [ConnectorId.Jira]: { name: 'atlassian', transport: McpTransport.Sse, target: 'https://mcp.atlassian.com/v1/sse' },
  [ConnectorId.Slack]: { name: 'slack', transport: McpTransport.Http, target: 'https://mcp.slack.com/mcp' },
  [ConnectorId.Sentry]: { name: 'sentry', transport: McpTransport.Http, target: 'https://mcp.sentry.dev/mcp' },
};

/** Connectors that sign in through a token the console keeps in the Keychain. */
export const TOKEN_CONNECTORS: ConnectorId[] = [ConnectorId.Gitlab, ConnectorId.Bitbucket];

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const count = z.number().int().min(1);

export const connectorConfigSchemas = {
  [ConnectorId.Datadog]: z.strictObject({
    site: z.string().min(1),
    environments: z.array(z.string().min(1)),
    daily_scan_time: time,
    default_interval: z.enum(['24h', '12h', '6h']),
    rapid_errors_per_10m: count,
    failing_errors_per_hour: count,
    ignore: z.array(z.strictObject({ kind: z.enum(['status_class', 'route']), value: z.string().min(1) })),
    reports_folder: z.string().min(1),
  }),
  [ConnectorId.Jira]: z.strictObject({
    site: z.string(),
    project_key: z.string(),
    issue_types: z.strictObject({ bug: z.string().min(1), improvement: z.string().min(1) }),
    in_review_status: z.string().min(1),
    create_tickets: z.boolean(),
  }),
  [ConnectorId.Github]: z.strictObject({ org: z.string().nullable() }),
  [ConnectorId.Gitlab]: z.strictObject({ host: z.string().min(1) }),
  [ConnectorId.Bitbucket]: z.strictObject({
    workspace: z.string(),
    ssh_key_path: z.string().min(1),
    pr_target_branch: z.string().min(1),
  }),
  [ConnectorId.Slack]: z.strictObject({ workspace: z.string(), alert_channel: z.string(), review_dm_to: z.string() }),
  [ConnectorId.Sentry]: z.strictObject({ org: z.string().nullable() }),
} satisfies Record<ConnectorId, z.ZodType>;

export const DEFAULT_CONNECTOR_CONFIG: Record<ConnectorId, Record<string, unknown>> = {
  [ConnectorId.Datadog]: {
    site: 'datadoghq.com',
    environments: ['prod'],
    daily_scan_time: '09:00',
    default_interval: '24h',
    rapid_errors_per_10m: 100,
    failing_errors_per_hour: 5,
    ignore: [],
    reports_folder: 'reports',
  },
  [ConnectorId.Jira]: {
    site: '',
    project_key: '',
    issue_types: { bug: 'Bug', improvement: 'Improvement' },
    in_review_status: 'In Review',
    create_tickets: true,
  },
  [ConnectorId.Github]: { org: null },
  [ConnectorId.Gitlab]: { host: 'gitlab.com' },
  [ConnectorId.Bitbucket]: { workspace: '', ssh_key_path: '~/.ssh/id_ed25519', pr_target_branch: 'main' },
  [ConnectorId.Slack]: { workspace: '', alert_channel: '', review_dm_to: '' },
  [ConnectorId.Sentry]: { org: null },
};

export const connectorSchema = z.object({
  id: z.enum(ConnectorId),
  name: z.string(),
  via: z.string(),
  status: z.enum(HealthStatus),
  status_detail: z.string().nullable(),
  account_label: z.string().nullable(),
  login: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  last_checked_at: z.string().nullable(),
  secret_stored: z.boolean(),
});

export type Connector = z.infer<typeof connectorSchema>;

export const connectorListSchema = z.object({
  data: z.array(connectorSchema),
  meta: z.object({ next_cursor: z.null() }),
});

export const updateConnectorSchema = z.object({ config: z.record(z.string(), z.unknown()) });

export const connectConnectorSchema = z.object({ secret: z.string().min(1).optional() });

export const connectorCheckSchema = z.object({
  status: z.enum(HealthStatus),
  status_detail: z.string().nullable(),
  account_label: z.string().nullable(),
  login: z.string().nullable(),
  last_checked_at: z.string(),
});

export type ConnectorCheck = z.infer<typeof connectorCheckSchema>;
