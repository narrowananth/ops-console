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
  /** Logs of a Grafana Loki, read with the logcli CLI. */
  LokiLogs = 'loki_logs',
  /** Logs of a New Relic account, read with the newrelic CLI. */
  NewRelicLogs = 'new_relic_logs',
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
  [ConnectorId.LokiLogs]: 'logcli CLI',
  [ConnectorId.NewRelicLogs]: 'newrelic CLI',
};

/**
 * An OAuth app the service registered for MCP clients, for a server that offers no dynamic client registration. Its
 * one allowed redirect is `http://localhost:<callback_port>/callback`.
 */
export type McpOAuthClient = { client_id: string; callback_port: number };

/**
 * The MCP Server each Connector registers when it connects. Jira and Bitbucket share Atlassian's; Disconnect removes a
 * server once no connected Connector rides it.
 */
export const CONNECTOR_SERVERS: Partial<
  Record<ConnectorId, { name: string; transport: McpTransport; target: string; oauth?: McpOAuthClient }>
> = {
  [ConnectorId.Datadog]: { name: 'datadog-pup', transport: McpTransport.Stdio, target: 'pup mcp serve' },
  [ConnectorId.Github]: { name: 'github', transport: McpTransport.Stdio, target: 'github-mcp-server stdio' },
  [ConnectorId.Jira]: { name: 'atlassian', transport: McpTransport.Http, target: 'https://mcp.atlassian.com/v1/mcp' },
  [ConnectorId.Bitbucket]: {
    name: 'atlassian',
    transport: McpTransport.Http,
    target: 'https://mcp.atlassian.com/v1/mcp',
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

/** How `logcli` signs in: no secret, a bearer token, or basic with a username and password. */
export const LOKI_AUTH = ['none', 'bearer', 'basic'] as const;

/** A LogQL label name. It goes into queries, so nothing else is accepted. */
const logqlLabel = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'a label name: letters, digits and _');

const httpUrl = z.url({ protocol: /^https?$/ });
/** `https://user:token@host`: anything before an `@` in the part of the URL that holds the host. */
const hasUserinfo = (url: string): boolean => /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url);
/** The Loki address, or empty until chosen. `logcli` gets the secret apart from it, so the URL holds none. */
const lokiUrl = z
  .string()
  .refine((url) => url === '' || httpUrl.safeParse(url).success, 'an http or https URL')
  .refine((url) => !hasUserinfo(url), 'credentials belong in the secret field, not the URL');

const MATCHER = String.raw`[A-Za-z_][A-Za-z0-9_]*\s*(?:=~|!~|!=|=)\s*"(?:[^"\\\n]|\\.)*"`;
/** Extra stream matchers such as `cluster="prod-1"`: comma-separated, each a label, an operator and a quoted value. */
const logqlMatchers = z
  .string()
  .regex(new RegExp(`^\\s*(?:${MATCHER}(?:\\s*,\\s*${MATCHER})*)?\\s*$`), 'stream matchers such as cluster="prod-1"');

/** Where a New Relic account lives: its data center. */
export const NEW_RELIC_REGIONS = ['US', 'EU', 'JP'] as const;

/** An attribute name. It goes into queries inside backticks, so nothing else is accepted. */
const nrqlAttribute = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'an attribute name: letters, digits and _ . -');

/** A clause the reader adds itself, or one that ends the condition. Quoted text counts too. */
const FILTER_REFUSED =
  /\b(?:SINCE|UNTIL|LIMIT|FACET|TIMESERIES|ORDER\s+BY|COMPARE\s+WITH|SLIDE\s+BY|OFFSET|WITH\s+TIMEZONE|EXTRAPOLATE)\b|;/i;
/** Whether a quote opened in `text` is never closed, or a parenthesis outside quotes has no partner. A backslash escapes. */
function unbalanced(text: string): boolean {
  let open: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (char === '\\') i++;
    else if (open !== null) open = char === open ? null : open;
    else if (char === "'" || char === '"' || char === '`') open = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth < 0) return true;
  }
  return open !== null || depth !== 0;
}
/** One condition such as `cluster = 'prod-1'`, or empty for none. */
const nrqlFilter = z
  .string()
  .refine(
    (text) => !FILTER_REFUSED.test(text),
    'one condition: no SINCE, UNTIL, LIMIT, FACET, TIMESERIES, ORDER BY, COMPARE WITH, SLIDE BY, OFFSET, WITH TIMEZONE, EXTRAPOLATE or ;',
  )
  .refine((text) => !unbalanced(text), 'a condition with its quotes and parentheses closed');

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
  /** `url`: empty until chosen. `username` is for basic only; the secret is in the Keychain, never here. */
  [ConnectorId.LokiLogs]: z.strictObject({
    url: lokiUrl,
    org_id: z.string(),
    auth: z.enum(LOKI_AUTH),
    username: z.string(),
    service_label: logqlLabel,
    env_label: logqlLabel,
    selector: logqlMatchers,
    format: z.enum(['json', 'logfmt']),
    environments: z.array(z.string().min(1)),
    daily_scan_time: time,
    default_interval: z.enum(['24h', '12h', '6h']),
    rapid_errors_per_10m: count,
    failing_errors_per_hour: count,
    ignore: z.array(z.strictObject({ kind: z.enum(['status_class', 'route']), value: z.string().min(1) })),
    reports_folder: z.string().min(1),
  }),
  /** `account_id`: digits, empty until chosen. The API key is in the Keychain, never here. */
  [ConnectorId.NewRelicLogs]: z.strictObject({
    account_id: z.string().regex(/^\d*$/, 'digits only'),
    region: z.enum(NEW_RELIC_REGIONS),
    service_attribute: nrqlAttribute,
    env_attribute: nrqlAttribute,
    filter: nrqlFilter,
    environments: z.array(z.string().min(1)),
    daily_scan_time: time,
    default_interval: z.enum(['24h', '12h', '6h']),
    rapid_errors_per_10m: count,
    failing_errors_per_hour: count,
    ignore: z.array(z.strictObject({ kind: z.enum(['status_class', 'route']), value: z.string().min(1) })),
    reports_folder: z.string().min(1),
  }),
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
    url: '',
    org_id: '',
    auth: 'none',
    username: '',
    service_label: 'service_name',
    env_label: 'deployment_environment_name',
    selector: '',
    format: 'json',
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
    service_attribute: 'service.name',
    env_attribute: 'environment',
    filter: '',
    environments: ['prod'],
    daily_scan_time: '09:00',
    default_interval: '24h',
    rapid_errors_per_10m: 100,
    failing_errors_per_hour: 5,
    ignore: [],
    reports_folder: 'reports',
  },
};

/**
 * `POST /connectors/loki_logs/connect`: the config fields the pane edits, and the secret, which is write-only. A field
 * left out keeps its stored value; the Connector checks the values against its config schema (422 `validation_failed`).
 */
export const lokiConnectBodySchema = z.object({
  url: z.string().optional(),
  org_id: z.string().optional(),
  auth: z.string().optional(),
  username: z.string().optional(),
  service_label: z.string().optional(),
  env_label: z.string().optional(),
  selector: z.string().optional(),
  format: z.string().optional(),
  /** Bearer token or basic password. Left out, the one in the Keychain stays. */
  secret: z.string().optional(),
});

/**
 * `POST /connectors/new_relic_logs/connect`: the config fields the pane edits, and the API key, which is write-only. A
 * field left out keeps its stored value; the Connector checks the values against its config schema (422
 * `validation_failed`).
 */
export const newRelicConnectBodySchema = z.object({
  account_id: z.string().optional(),
  region: z.string().optional(),
  service_attribute: z.string().optional(),
  env_attribute: z.string().optional(),
  filter: z.string().optional(),
  /** A User API key. Left out, the one in the Keychain stays. */
  secret: z.string().optional(),
});

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
