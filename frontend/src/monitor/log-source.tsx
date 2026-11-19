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

/** `Datadog`, `OpenTelemetry logs` or `Datadog and OpenTelemetry logs`: the Connectors a view reads from. */
export function sourceNames(sources: LogSource[]): string {
  return sources.map((source) => CONNECTOR_NAMES[source]).join(' and ');
}

const filterSchema = z.object({
  service: z.string().nullish(),
  env: z.string().nullish(),
  status: z.number().nullish(),
  method: z.string().nullish(),
  path: z.string().nullish(),
});

/**
 * The Alert's stored query for the operator: the Datadog query as it is, or an OpenTelemetry filter as a line such as
 * `service api, env prod, 500 POST /orders`. A filter that does not parse shows as stored.
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
  const { service, env, status, method, path } = filter.data;
  const request = [status, method, path].filter((part) => part !== null && part !== undefined && part !== '');
  return [service ? `service ${service}` : '', env ? `env ${env}` : '', request.join(' ')]
    .filter((part) => part !== '')
    .join(', ');
}
