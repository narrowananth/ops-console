import { CONNECTOR_SERVERS, RunPurpose, SessionKind } from '@ops-console/shared';

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

export function mcpScope(purpose: RunPurpose, kind: SessionKind): McpScope {
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
        withoutConnectors: connectorServers(...PR_JOB_KEEPS, 'datadog-pup'),
      };
    case RunPurpose.Verify:
      // Datadog and the read-only Connections it cross-checks.
      return { none: false, withoutConnections: false, withoutConnectors: connectorServers('datadog-pup') };
    case RunPurpose.Chat:
      // A Dev tools Session is scoped to its own Connections elsewhere; any other chat starts none of them.
      return { none: false, withoutConnections: kind !== SessionKind.Devtools, withoutConnectors: [] };
  }
}
