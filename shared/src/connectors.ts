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
  Shopify = 'shopify',
  Slashdocs = 'slashdocs',
  GoogleDocs = 'google_docs',
  GoogleSheets = 'google_sheets',
  GoogleDrive = 'google_drive',
  /** Logs a Collector's file exporter writes to a folder on this Mac. */
  OtelLogs = 'otel_logs',
  /** Logs of an AWS account, read with the AWS CLI. */
  CloudWatchLogs = 'cloudwatch_logs',
  /** Logs of a Loki data source in a Grafana Cloud stack, read through Grafana's hosted MCP server. */
  LokiLogs = 'loki_logs',
  /** Logs of a New Relic account, read through New Relic's hosted MCP server. */
  NewRelicLogs = 'new_relic_logs',
  /** Figma's designs, read through its hosted MCP server. Read only: the console refuses every tool off the Read list. */
  Figma = 'figma',
}

export const CONNECTOR_ORDER: ConnectorId[] = Object.values(ConnectorId);

/** The Connectors that sign in to Google with the client the build ships. */
export const GOOGLE_CONNECTORS: ConnectorId[] = [
  ConnectorId.GoogleDocs,
  ConnectorId.GoogleSheets,
  ConnectorId.GoogleDrive,
];

export const isGoogleConnector = (id: ConnectorId): boolean => GOOGLE_CONNECTORS.includes(id);

/**
 * The scopes each Google Connector asks for: the one its tools need (Docs and Sheets read and write, Drive only reads),
 * and `openid email` to show which Google account signed in.
 */
export const GOOGLE_SCOPES: Record<string, string[]> = {
  [ConnectorId.GoogleDocs]: ['openid', 'email', 'https://www.googleapis.com/auth/documents'],
  [ConnectorId.GoogleSheets]: ['openid', 'email', 'https://www.googleapis.com/auth/spreadsheets'],
  [ConnectorId.GoogleDrive]: ['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly'],
};

export const CONNECTOR_NAMES: Record<ConnectorId, string> = {
  [ConnectorId.Datadog]: 'Datadog',
  [ConnectorId.Jira]: 'Jira',
  [ConnectorId.Github]: 'GitHub',
  [ConnectorId.Gitlab]: 'GitLab',
  [ConnectorId.Bitbucket]: 'Bitbucket',
  [ConnectorId.Slack]: 'Slack',
  [ConnectorId.Sentry]: 'Sentry',
  [ConnectorId.Shopify]: 'Shopify',
  [ConnectorId.Slashdocs]: 'slashdocs',
  [ConnectorId.GoogleDocs]: 'Google Docs',
  [ConnectorId.GoogleSheets]: 'Google Sheets',
  [ConnectorId.GoogleDrive]: 'Google Drive',
  [ConnectorId.OtelLogs]: 'OpenTelemetry logs',
  [ConnectorId.CloudWatchLogs]: 'CloudWatch logs',
  [ConnectorId.LokiLogs]: 'Loki logs',
  [ConnectorId.NewRelicLogs]: 'New Relic logs',
  [ConnectorId.Figma]: 'Figma',
};

/** How the console reaches the service (ADR 0005). */
export const CONNECTOR_VIA: Record<ConnectorId, string> = {
  [ConnectorId.Datadog]: 'pup CLI + datadog-pup MCP',
  [ConnectorId.Jira]: 'Atlassian MCP',
  [ConnectorId.Github]: 'gh CLI + GitHub MCP',
  [ConnectorId.Gitlab]: 'glab CLI',
  [ConnectorId.Bitbucket]: 'bkt CLI + Atlassian MCP',
  [ConnectorId.Slack]: 'Slack MCP',
  [ConnectorId.Sentry]: 'Sentry MCP',
  [ConnectorId.Shopify]: 'Shopify Dev MCP',
  [ConnectorId.Slashdocs]: 'slashdocs CLI',
  [ConnectorId.GoogleDocs]: 'Google Docs API',
  [ConnectorId.GoogleSheets]: 'Google Sheets API',
  [ConnectorId.GoogleDrive]: 'Google Drive API',
  [ConnectorId.OtelLogs]: 'a local folder',
  [ConnectorId.CloudWatchLogs]: 'aws CLI + CloudWatch MCP',
  [ConnectorId.LokiLogs]: 'Grafana Cloud MCP',
  [ConnectorId.NewRelicLogs]: 'New Relic MCP',
  [ConnectorId.Figma]: 'Figma MCP',
};

/**
 * An OAuth app the service registered for MCP clients, for a server that offers no dynamic client registration. Its
 * one allowed redirect is `http://localhost:<callback_port>/callback`.
 */
export type McpOAuthClient = { client_id: string; callback_port: number };

/** New Relic's hosted MCP server address in each region. */
export const NEW_RELIC_MCP_URLS: Record<(typeof NEW_RELIC_REGIONS)[number], string> = {
  US: 'https://mcp.newrelic.com/mcp/',
  EU: 'https://mcp.eu.newrelic.com/mcp/',
  JP: 'https://mcp.jp.newrelic.com/mcp/',
};

/**
 * The MCP Server each Connector registers when it connects. Jira and Bitbucket share Atlassian's; Disconnect removes a
 * server once no connected Connector rides it.
 */
export const CONNECTOR_SERVERS: Partial<
  Record<ConnectorId, { name: string; transport: McpTransport; target: string; oauth?: McpOAuthClient }>
> = {
  [ConnectorId.Datadog]: { name: 'datadog-pup', transport: McpTransport.Stdio, target: 'pup mcp serve' },
  [ConnectorId.Github]: { name: 'github', transport: McpTransport.Stdio, target: 'github-mcp-server stdio' },
  [ConnectorId.Jira]: { name: 'atlassian', transport: McpTransport.Http, target: 'https://mcp.atlassian.com/v2/mcp' },
  [ConnectorId.Bitbucket]: {
    name: 'atlassian',
    transport: McpTransport.Http,
    target: 'https://mcp.atlassian.com/v2/mcp',
  },
  // Slack's server takes only its partner apps: this is the one Claude Code's Slack plugin signs in with.
  [ConnectorId.Slack]: {
    name: 'slack',
    transport: McpTransport.Http,
    target: 'https://mcp.slack.com/mcp',
    oauth: { client_id: '1601185624273.8899143856786', callback_port: 3118 },
  },
  [ConnectorId.Sentry]: { name: 'sentry', transport: McpTransport.Http, target: 'https://mcp.sentry.dev/mcp' },
  [ConnectorId.Shopify]: { name: 'shopify', transport: McpTransport.Stdio, target: 'npx -y @shopify/dev-mcp@latest' },
  // The Google bridge (`ops-console google-mcp <product>`): it reads the sign-in from the Keychain and calls the product's REST API.
  [ConnectorId.GoogleDocs]: {
    name: 'google-docs',
    transport: McpTransport.Stdio,
    target: 'ops-console google-mcp docs',
  },
  [ConnectorId.GoogleSheets]: {
    name: 'google-sheets',
    transport: McpTransport.Stdio,
    target: 'ops-console google-mcp sheets',
  },
  [ConnectorId.GoogleDrive]: {
    name: 'google-drive',
    transport: McpTransport.Stdio,
    target: 'ops-console google-mcp drive',
  },
  // Grafana Cloud's hosted server. The console signs in to it itself and registers it for the agent.
  [ConnectorId.LokiLogs]: { name: 'grafana', transport: McpTransport.Http, target: 'https://mcp.grafana.com/mcp' },
  // New Relic's hosted server; Connect registers the address of the Region chosen.
  [ConnectorId.NewRelicLogs]: { name: 'newrelic', transport: McpTransport.Http, target: NEW_RELIC_MCP_URLS.US },
  // Figma's hosted server. It takes the sign-in of Claude Code's own client, so none is pinned here.
  [ConnectorId.Figma]: { name: 'figma', transport: McpTransport.Http, target: 'https://mcp.figma.com/mcp' },
  // AWS Labs' CloudWatch server. The Connector registers it with its profile and region in the environment.
  [ConnectorId.CloudWatchLogs]: {
    name: 'cloudwatch',
    transport: McpTransport.Stdio,
    target: 'uvx awslabs.cloudwatch-mcp-server@latest',
  },
};

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const count = z.number().int().min(1);
/** An AWS profile or region name: it goes into the MCP server's command line, so no spaces or quotes. */
const awsName = z.string().regex(/^(?!-)[A-Za-z0-9_.@+=,-]*$/, 'letters, digits and . _ @ + = , -');

/** Where a New Relic account lives: its data center. */
export const NEW_RELIC_REGIONS = ['US', 'EU', 'JP'] as const;

/** How New Relic logs are read: through New Relic's MCP server (`mcp`) or with a User API key through its API (`key`). */
export const NEW_RELIC_ROUTES = ['mcp', 'key'] as const;
export type NewRelicRoute = (typeof NEW_RELIC_ROUTES)[number];

/** One CloudWatch log group the operator picked, and the Service it is. */
export const logGroupSchema = z.strictObject({
  name: z.string().min(1),
  service: z.string().min(1),
  env: z.string().min(1),
});

export type LogGroupPick = z.infer<typeof logGroupSchema>;

/** `GET /connectors/cloudwatch_logs/log-groups`: the log groups of the Connector's profile and region. */
export const logGroupListSchema = z.object({
  data: z.array(z.object({ name: z.string() })),
  meta: z.object({ next_cursor: z.null() }),
});

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
  [ConnectorId.Shopify]: z.strictObject({}),
  /** The slashdocs server to sign in to; blank uses the CLI's active one. */
  [ConnectorId.Slashdocs]: z.strictObject({ server: z.string() }),
  [ConnectorId.GoogleDocs]: z.strictObject({}),
  [ConnectorId.GoogleSheets]: z.strictObject({}),
  [ConnectorId.GoogleDrive]: z.strictObject({}),
  /** `folder`: the absolute path of the Log folder; empty until chosen. */
  [ConnectorId.OtelLogs]: z.strictObject({
    folder: z.string(),
    environments: z.array(z.string().min(1)),
    daily_scan_time: time,
    default_interval: z.enum(['24h', '12h', '6h']),
    rapid_errors_per_10m: count,
    failing_errors_per_hour: count,
    ignore: z.array(z.strictObject({ kind: z.enum(['status_class', 'route']), value: z.string().min(1) })),
    reports_folder: z.string().min(1),
  }),
  /** `profile` and `region`: empty until chosen. Each picked log group is one Service. */
  [ConnectorId.CloudWatchLogs]: z.strictObject({
    profile: awsName,
    region: awsName,
    log_groups: z.array(logGroupSchema),
    environments: z.array(z.string().min(1)),
    daily_scan_time: time,
    default_interval: z.enum(['24h', '12h', '6h']),
    rapid_errors_per_10m: count,
    failing_errors_per_hour: count,
    ignore: z.array(z.strictObject({ kind: z.enum(['status_class', 'route']), value: z.string().min(1) })),
    reports_folder: z.string().min(1),
  }),
  /** `datasource_uid`: the Loki data source of the stack, empty until chosen. The sign-in is in the Keychain, never here. */
  [ConnectorId.LokiLogs]: z.strictObject({
    datasource_uid: z.string(),
    environments: z.array(z.string().min(1)),
    daily_scan_time: time,
    default_interval: z.enum(['24h', '12h', '6h']),
    rapid_errors_per_10m: count,
    failing_errors_per_hour: count,
    ignore: z.array(z.strictObject({ kind: z.enum(['status_class', 'route']), value: z.string().min(1) })),
    reports_folder: z.string().min(1),
  }),
  /**
   * `account_id`: digits, empty until chosen. `region` picks the server's or the API's address. `route` says which
   * sign-in is in use: Claude Code's for the MCP server, or the User API key in the Keychain, never here.
   */
  [ConnectorId.NewRelicLogs]: z.strictObject({
    account_id: z.string().regex(/^\d*$/, 'digits only'),
    region: z.enum(NEW_RELIC_REGIONS),
    route: z.enum(NEW_RELIC_ROUTES).default('mcp'),
    environments: z.array(z.string().min(1)),
    daily_scan_time: time,
    default_interval: z.enum(['24h', '12h', '6h']),
    rapid_errors_per_10m: count,
    failing_errors_per_hour: count,
    ignore: z.array(z.strictObject({ kind: z.enum(['status_class', 'route']), value: z.string().min(1) })),
    reports_folder: z.string().min(1),
  }),
  [ConnectorId.Figma]: z.strictObject({}),
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
  [ConnectorId.Shopify]: {},
  [ConnectorId.Slashdocs]: { server: '' },
  [ConnectorId.GoogleDocs]: {},
  [ConnectorId.GoogleSheets]: {},
  [ConnectorId.GoogleDrive]: {},
  [ConnectorId.OtelLogs]: {
    folder: '',
    environments: ['prod'],
    daily_scan_time: '09:00',
    default_interval: '24h',
    rapid_errors_per_10m: 100,
    failing_errors_per_hour: 5,
    ignore: [],
    reports_folder: 'reports',
  },
  [ConnectorId.CloudWatchLogs]: {
    profile: '',
    region: '',
    log_groups: [],
    environments: ['prod'],
    daily_scan_time: '09:00',
    default_interval: '24h',
    rapid_errors_per_10m: 100,
    failing_errors_per_hour: 5,
    ignore: [],
    reports_folder: 'reports',
  },
  [ConnectorId.LokiLogs]: {
    datasource_uid: '',
    environments: ['prod'],
    daily_scan_time: '09:00',
    default_interval: '24h',
    rapid_errors_per_10m: 100,
    failing_errors_per_hour: 5,
    ignore: [],
    reports_folder: 'reports',
  },
  [ConnectorId.NewRelicLogs]: {
    account_id: '',
    region: 'US',
    route: 'mcp',
    environments: ['prod'],
    daily_scan_time: '09:00',
    default_interval: '24h',
    rapid_errors_per_10m: 100,
    failing_errors_per_hour: 5,
    ignore: [],
    reports_folder: 'reports',
  },
  [ConnectorId.Figma]: {},
};

/**
 * `POST /connectors/:id/connect`: the choices a pane makes above Connect or after sign-in. Each Connector reads its own
 * and checks the values (422 `validation_failed`); a field left out keeps its stored value. New Relic's `region` is
 * `US`, `EU` or `JP`; CloudWatch's is an AWS region.
 */
export const connectBodySchema = z.object({
  region: z.string().optional(),
  /** New Relic: the account to read, when the sign-in can read several. */
  account_id: z.string().optional(),
  /** New Relic: a User API key to read through New Relic's API, in place of the MCP sign-in. It goes to the Keychain. */
  api_key: z.string().trim().min(1).max(200).optional(),
  /** Loki: the data source to read, when the stack has several. */
  datasource_uid: z.string().optional(),
  /** CloudWatch: the AWS profile to sign in. */
  profile: z.string().optional(),
  log_groups: z.array(logGroupSchema).optional(),
  /** OpenTelemetry: the Log folder, as the folder dialog answered. */
  folder: z.string().optional(),
});

export type ConnectBody = z.infer<typeof connectBodySchema>;

/**
 * `GET /connectors/loki_logs/datasources` and `GET /connectors/new_relic_logs/accounts`: what a signed-in Connector can
 * read, for the picker. 409 `invalid_state` while the Connector is not signed in.
 */
export const pickableListSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string() })),
  meta: z.object({ next_cursor: z.null() }),
});

export type Pickable = z.infer<typeof pickableListSchema>['data'][number];

/** `GET /connectors/cloudwatch_logs/profiles`: the AWS profiles on this Mac, `default` first, and each one's region. */
export const awsProfileListSchema = z.object({
  data: z.array(z.object({ name: z.string(), region: z.string().nullable() })),
  meta: z.object({ next_cursor: z.null() }),
});

export type AwsProfile = z.infer<typeof awsProfileListSchema>['data'][number];

/** The commercial AWS regions, for CloudWatch's Region picker. */
export const AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-north-1',
  'eu-south-1',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-east-1',
  'sa-east-1',
  'me-south-1',
  'af-south-1',
] as const;

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
  /** Set while a sign-in waits on the operator; `code` is the one-time code GitHub asks for, else `null`. */
  sign_in: z.object({ code: z.string().nullable(), url: z.string().nullable() }).nullable(),
  /**
   * Set when the sign-in finished and waits for the operator to pick a Loki data source or a New Relic account, which
   * the pane lists from `GET /connectors/loki_logs/datasources` or `/new_relic_logs/accounts`; `null` otherwise.
   */
  pick: z.enum(['data_source', 'account']).nullable(),
});

export type Connector = z.infer<typeof connectorSchema>;

export const connectorListSchema = z.object({
  data: z.array(connectorSchema),
  meta: z.object({ next_cursor: z.null() }),
});

export const updateConnectorSchema = z.object({ config: z.record(z.string(), z.unknown()) });

export const connectorCheckSchema = z.object({
  status: z.enum(HealthStatus),
  status_detail: z.string().nullable(),
  account_label: z.string().nullable(),
  login: z.string().nullable(),
  last_checked_at: z.string(),
});

export type ConnectorCheck = z.infer<typeof connectorCheckSchema>;
