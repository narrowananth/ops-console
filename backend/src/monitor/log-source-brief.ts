import { CONNECTOR_NAMES, ConnectorId, type LogSource } from '@ops-console/shared';

/**
 * What the agent is told about the Alert's log source. A Datadog Alert has the pup CLI and the Datadog MCP Server, as
 * the Playbook's rules say; the Log folder has no tool, and the agent never reads it.
 */
export function logSourceRule(connector: LogSource): string {
  if (connector !== ConnectorId.OtelLogs) return '';
  return `Log source: ${CONNECTOR_NAMES[connector]}, read by the console from a folder on the operator's Mac that you cannot read. Use no \`pup\` and no Datadog MCP Server for this Alert. You have no log tool: work from the log lines here, and say in the Report when you needed more logs than they give.`;
}

/** The Alert's stored query as the brief names it: Datadog's query string, or the OpenTelemetry filter. */
export const queryLabel = (connector: LogSource): string =>
  connector === ConnectorId.OtelLogs ? `${CONNECTOR_NAMES[connector]} filter` : 'Datadog query';
