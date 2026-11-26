import { CONNECTOR_SERVERS, ConnectorId, type LogSource, RunPurpose } from '@ops-console/shared';
import { CLOUDWATCH_SERVER } from './cloudwatch-tools';

/**
 * Every MCP server a run starts costs start-up time and tool definitions in the prompt: all sixteen of a full setup
 * meant 7 s before the first token and 21k tokens against 1.2 s and 3.5k with none. A run starts the servers its
 * purpose can use.
 */
export type McpScope = {
  /** Only the console's own tools: no registered server starts. */
  none: boolean;
  /** Connection servers (databases) stay out. */
  withoutConnections: boolean;
  /** Connector servers, by name, that stay out. */
  withoutConnectors: string[];
};

const connectorServers = (...keep: string[]): string[] =>
  [...new Set(Object.values(CONNECTOR_SERVERS).map((server) => server?.name ?? ''))].filter(
    (name) => name !== '' && !keep.includes(name),
  );

/** What a pull request job reads: the Git host's server and the ticket in Atlassian. */
const PR_JOB_KEEPS = ['github', 'atlassian'];

const serverOf = (id: ConnectorId): string => (CONNECTOR_SERVERS[id] as { name: string }).name;

/**
 * `scopesConnections`: the Session's kind scopes its own Connections (`SessionKindHandler.deniedServers`), so a chat
 * starts those it names. `logSource` is the log source of the Alert the run works on, when it has one: only a Datadog Alert starts the Datadog
 * server, only a Loki or New Relic Alert starts that source's hosted server, and only a CloudWatch Alert, or a run with
 * no Alert, starts the CloudWatch one.
 */
export function mcpScope(
  purpose: RunPurpose,
  scopesConnections: boolean,
  logSource: LogSource | null = null,
): McpScope {
  const datadog = logSource === null || logSource === ConnectorId.Datadog ? ['datadog-pup'] : [];
  const cloudWatch = logSource === null || logSource === ConnectorId.CloudWatchLogs ? [CLOUDWATCH_SERVER] : [];
  const hosted = [ConnectorId.LokiLogs, ConnectorId.NewRelicLogs]
    .filter((id) => logSource === null || logSource === id)
    .map(serverOf);
  switch (purpose) {
    case RunPurpose.OpenPullRequest:
      return { none: true, withoutConnections: true, withoutConnectors: [] };
    case RunPurpose.AgentReview:
    case RunPurpose.ReplyCheck:
    case RunPurpose.CommentPass:
      return { none: false, withoutConnections: true, withoutConnectors: connectorServers(...PR_JOB_KEEPS) };
    case RunPurpose.Fix:
      return {
        none: false,
        withoutConnections: true,
        withoutConnectors: connectorServers(...PR_JOB_KEEPS, ...datadog, ...hosted),
      };
    case RunPurpose.Verify:
      // The Alert's log source server, and the read-only Connections it cross-checks.
      return {
        none: false,
        withoutConnections: false,
        withoutConnectors: connectorServers(...datadog, ...cloudWatch, ...hosted),
      };
    case RunPurpose.Chat:
      // A kind that scopes its Connections leaves out the ones outside the scope; any other chat starts none of them.
      return { none: false, withoutConnections: !scopesConnections, withoutConnectors: [] };
  }
}

/**
 * Whether the console's own New Relic query tool reaches a run: the runs that start New Relic's MCP server, since a
 * User API key leaves that server out and the daemon holds the key.
 */
export function offersNewRelicQuery(purpose: RunPurpose, logSource: LogSource | null): boolean {
  const own = logSource === null || logSource === ConnectorId.NewRelicLogs;
  return own && (purpose === RunPurpose.Verify || purpose === RunPurpose.Fix || purpose === RunPurpose.Chat);
}
