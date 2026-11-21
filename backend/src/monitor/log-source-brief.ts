import { CONNECTOR_NAMES, ConnectorId, type LogSource } from '@ops-console/shared';

/**
 * What the agent is told about the Alert's log source. A Datadog Alert has the pup CLI and the Datadog MCP Server, as
 * the Playbook's rules say. The Log folder has no tool, and the agent never reads it. A CloudWatch Alert has the log
 * tools of the CloudWatch MCP Server. A Loki Alert has the Grafana MCP Server, and a New Relic Alert the New Relic one,
 * each registered with Claude Code when the Connector connected.
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
    return `Log source: ${name}, a Loki data source in Grafana Cloud that the console reads through Grafana's hosted server. Use no \`pup\` and no Datadog MCP Server for this Alert. When you need more logs than the lines here, use the Grafana MCP Server's Loki tools: query logs with LogQL, list label names and values. Query the service and env in the filter, with the labels service_name and deployment_environment_name. Read only.`;
  }
  if (connector === ConnectorId.NewRelicLogs) {
    return `Log source: ${name}, an account the console reads through New Relic's hosted server. Use no \`pup\` and no Datadog MCP Server for this Alert. When you need more logs than the lines here, use the New Relic MCP Server's NRQL query tool. Query the Log event type with the service.name and environment attributes in the filter. Read only.`;
  }
  return '';
}

/** The Alert's stored query as the brief names it: Datadog's query string, or the other sources' filter. */
export const queryLabel = (connector: LogSource): string =>
  connector === ConnectorId.Datadog ? 'Datadog query' : `${CONNECTOR_NAMES[connector]} filter`;
