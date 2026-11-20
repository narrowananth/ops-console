import {
  CONNECTOR_NAMES,
  type Connector,
  ConnectorId,
  HealthStatus,
  LOG_SOURCES,
  type LogSource,
  logSourceSchema,
} from '@ops-console/shared';
import { z } from 'zod';
import { useStored } from '../lib/remember';

/** The short name on a label: the source, not the Connector's longer name. */
export const SOURCE_LABEL: Record<LogSource, string> = {
  [ConnectorId.Datadog]: 'Datadog',
  [ConnectorId.OtelLogs]: 'OpenTelemetry',
  [ConnectorId.CloudWatchLogs]: 'CloudWatch',
  [ConnectorId.LokiLogs]: 'Loki',
  [ConnectorId.NewRelicLogs]: 'New Relic',
};

/** What an Alert's stored query is, said where the operator reads it. */
export const QUERY_TIP: Record<LogSource, string> = {
  [ConnectorId.Datadog]:
    'The Datadog log search that finds these failures. Paste it into Datadog Logs to see them there.',
  [ConnectorId.OtelLogs]:
    'The filter the Recheck reads the Log folder with: the Service, env, status code, method and path of these failures.',
  [ConnectorId.CloudWatchLogs]:
    'The filter the Recheck reads the log group with: the status code, method and path of these failures.',
  [ConnectorId.LokiLogs]:
    'The filter the Recheck reads Loki with: the Service, env, status code, method and path of these failures.',
  [ConnectorId.NewRelicLogs]:
    'The filter the Recheck reads New Relic with: the Service, env, status code, method and path of these failures.',
};

/** A small tag saying which log source an Alert or a Service was read from. */
export function SourceLabel({ source }: { source: LogSource }) {
  return (
    <span
      title={`Read from ${CONNECTOR_NAMES[source]}`}
      className="inline-flex flex-none items-center rounded bg-neutral-200 px-1.5 font-sans text-[11px] leading-4 font-normal text-neutral-700"
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

export type SourceFilter = LogSource | 'all';

/** The source the Monitor lists; kept across reloads like the other filters. */
export function useSourceFilter() {
  return useStored<SourceFilter>('monitor.source', z.union([z.literal('all'), logSourceSchema]), 'all');
}

/** The log sources a Scan can read now: connected and answering. */
export function connectedSources(connectors: Connector[]): LogSource[] {
  return LOG_SOURCES.filter((source) =>
    connectors.some((connector) => connector.id === source && connector.status === HealthStatus.Ok),
  );
}

/** The log sources that were connected and are not answering, each with the reason the check gave. */
export function downSources(connectors: Connector[]): { source: LogSource; reason: string | null }[] {
  return LOG_SOURCES.flatMap((source) => {
    const found = connectors.find((connector) => connector.id === source);
    return found && (found.status === HealthStatus.Fail || found.status === HealthStatus.Auth)
      ? [{ source, reason: found.status_detail }]
      : [];
  });
}

/** `Datadog`, `Datadog and OpenTelemetry logs` or `Datadog, OpenTelemetry logs and New Relic logs`: what a view reads. */
export function sourceNames(sources: LogSource[], joiner: 'and' | 'or' = 'and'): string {
  const names = sources.map((source) => CONNECTOR_NAMES[source]);
  const last = names.pop();
  return names.length > 0 ? `${names.join(', ')} ${joiner} ${last}` : (last ?? '');
}

/** The sentence that sends the operator to Integrations when no log source is connected. */
export const CONNECT_A_SOURCE = `Connect ${sourceNames([...LOG_SOURCES], 'or')} in Integrations`;

const filterSchema = z.object({
  log_group: z.string().nullish(),
  service: z.string().nullish(),
  env: z.string().nullish(),
  status: z.number().nullish(),
  method: z.string().nullish(),
  path: z.string().nullish(),
});

/**
 * The Alert's stored query for the operator: the Datadog query as it is, or a filter as a line such as
 * `service api, env prod, 500 POST /orders` (OpenTelemetry, Loki and New Relic) or `log group /ecs/api, 500 POST /orders` (CloudWatch). A
 * filter that does not parse shows as stored.
 */
export function readableQuery(source: LogSource, query: string): string {
  if (source === ConnectorId.Datadog) return query;
  let json: unknown;
  try {
    json = JSON.parse(query);
  } catch {
    return query;
  }
  const filter = filterSchema.safeParse(json);
  if (!filter.success) return query;
  const { log_group: logGroup, service, env, status, method, path } = filter.data;
  const request = [status, method, path].filter((part) => part !== null && part !== undefined && part !== '');
  return [
    logGroup ? `log group ${logGroup}` : '',
    service ? `service ${service}` : '',
    env ? `env ${env}` : '',
    request.join(' '),
  ]
    .filter((part) => part !== '')
    .join(', ');
}
