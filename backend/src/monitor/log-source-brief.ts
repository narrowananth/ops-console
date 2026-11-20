import { CONNECTOR_NAMES, ConnectorId, type LogSource } from '@ops-console/shared';

/**
 * What the agent is told about the Alert's log source. A Datadog Alert has the pup CLI and the Datadog MCP Server, as
 * the Playbook's rules say. The Log folder has no tool, and the agent never reads it. A CloudWatch Alert has the log
 * tools of the CloudWatch MCP Server. A Loki Alert has `logcli` through `run_integration`, with the address and
 * credentials set by the console. A New Relic Alert has `newrelic` through `run_integration`, with the key, account and
 * region set by the console.
 */
export function logSourceRule(connector: LogSource): string {
  const name = CONNECTOR_NAMES[connector];
  if (connector === ConnectorId.OtelLogs) {
    return `Log source: ${name}, read by the console from a folder on the operator's Mac that you cannot read. Use no \`pup\` and no Datadog MCP Server for this Alert. You have no log tool: work from the log lines here, and say in the Report when you needed more logs than they give.`;
  }
  if (connector === ConnectorId.CloudWatchLogs) {
    return `Log source: ${name}, a log group the console reads with the AWS CLI. Use no \`pup\` and no Datadog MCP Server for this Alert. When you need more logs than the lines here, use the CloudWatch log tools: list log groups, run a Logs Insights query, read its results and cancel it. Query the log group in the filter. You have no other CloudWatch tool.`;
  }
  if (connector === ConnectorId.LokiLogs) {
    return `Log source: ${name}, a Loki the console reads with the logcli CLI. Use no \`pup\` and no Datadog MCP Server for this Alert. When you need more logs than the lines here, use \`logcli\` through the \`run_integration\` tool (cli logcli, args query, labels or series, then the flags): pass no address or credentials, the console sets them. Query the service and env in the filter. You have no other Loki tool.`;
  }
  if (connector === ConnectorId.NewRelicLogs) {
    return `Log source: ${name}, an account the console reads with the newrelic CLI. Use no \`pup\` and no Datadog MCP Server for this Alert. When you need more logs than the lines here, use \`newrelic\` through the \`run_integration\` tool (cli newrelic, args nrql, query, --query, then the NRQL, optionally --format): pass no key, account or region, the console sets them. Query the Log event type with the service and env in the filter. You have no other New Relic tool.`;
  }
  return '';
}

/** The Alert's stored query as the brief names it: Datadog's query string, or the other sources' filter. */
export const queryLabel = (connector: LogSource): string =>
  connector === ConnectorId.Datadog ? 'Datadog query' : `${CONNECTOR_NAMES[connector]} filter`;
