import { CONNECTOR_SERVERS, ConnectorId } from '@ops-console/shared';

const serverOf = (id: ConnectorId): string => (CONNECTOR_SERVERS[id] as { name: string }).name;

/** The only tools of each hosted log server a run may call: data sources, labels and queries, reads all. */
const READ_TOOLS: [prefix: string, tools: string[]][] = [
  [
    `mcp__${serverOf(ConnectorId.LokiLogs)}__`,
    [
      'list_datasources',
      'get_datasource',
      'list_loki_label_names',
      'list_loki_label_values',
      'query_loki_logs',
      'query_loki_stats',
      'query_loki_patterns',
    ],
  ],
  [`mcp__${serverOf(ConnectorId.NewRelicLogs)}__`, ['execute_nrql_query', 'list_available_new_relic_accounts']],
];

/** Why a run may not call `tool`, when it is a Grafana or New Relic tool outside the read tools; null for any other call. */
export function hostedLogDenial(tool: string): string | null {
  const found = READ_TOOLS.find(([prefix]) => tool.startsWith(prefix));
  if (!found || found[1].includes(tool.slice(found[0].length))) return null;
  return 'Only the read tools of this log source are allowed: data sources, labels and log queries for Grafana, NRQL queries and the account list for New Relic.';
}
