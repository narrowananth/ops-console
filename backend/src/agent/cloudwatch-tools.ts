import { CONNECTOR_SERVERS, ConnectorId } from '@ops-console/shared';

/** The MCP server the CloudWatch logs Connector registers. */
export const CLOUDWATCH_SERVER = (CONNECTOR_SERVERS[ConnectorId.CloudWatchLogs] as { name: string }).name;

const PREFIX = `mcp__${CLOUDWATCH_SERVER}__`;

/** The only tools of that server a run may call: list log groups, run a Logs Insights query, read it, cancel it. */
const CLOUDWATCH_LOG_TOOLS = [
  'describe_log_groups',
  'execute_log_insights_query',
  'get_logs_insight_query_results',
  'cancel_logs_insight_query',
].map((name) => `${PREFIX}${name}`);

/** Why a run may not call `tool`, when it is a CloudWatch tool outside the log tools; null for any other call. */
export function cloudWatchDenial(tool: string): string | null {
  if (!tool.startsWith(PREFIX) || CLOUDWATCH_LOG_TOOLS.includes(tool)) return null;
  return 'Only the CloudWatch log tools are allowed: list log groups, run a Logs Insights query, read its results and cancel it.';
}
