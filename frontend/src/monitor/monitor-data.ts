import { type AlertListItem, ConnectorId, type LogSource, type StatusCodeCount } from '@ops-console/shared';
import { useAlerts, useLogServices, useStatusCodes } from '../lib/queries';
import { ascending } from '../lib/sort';
import { CLOSED } from './alert-status';
import { type SourceFilter, sourceNames } from './log-source';
import { shown as inMonitor, type ScanScope } from './scan-scope';

export type ServiceRow = { source: LogSource; name: string; errors: number | null };

/** Counts of the same status code from several sources add up. */
function mergeCodes(lists: StatusCodeCount[][]): StatusCodeCount[] {
  const counts = new Map<number, number>();
  for (const entry of lists.flat()) counts.set(entry.code, (counts.get(entry.code) ?? 0) + entry.count);
  return [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
}

/**
 * What the Monitor reads from the log sources in view: the Services with failing requests in the range, the HTTP
 * status codes there are, and the open Alerts of each Service. The hooks run for all five sources every time, so the
 * count of hooks never changes; a source out of view asks nothing.
 */
export function useMonitorData(connected: LogSource[], source: SourceFilter, scope: ScanScope) {
  const inView = connected.filter((one) => source === 'all' || one === source);
  const on = (one: LogSource) => inView.includes(one);
  const reads = [
    {
      source: ConnectorId.Datadog as LogSource,
      services: useLogServices(ConnectorId.Datadog, scope.range, scope.codes, on(ConnectorId.Datadog)),
      codes: useStatusCodes(ConnectorId.Datadog, scope.range, on(ConnectorId.Datadog)),
    },
    {
      source: ConnectorId.OtelLogs as LogSource,
      services: useLogServices(ConnectorId.OtelLogs, scope.range, scope.codes, on(ConnectorId.OtelLogs)),
      codes: useStatusCodes(ConnectorId.OtelLogs, scope.range, on(ConnectorId.OtelLogs)),
    },
    {
      source: ConnectorId.CloudWatchLogs as LogSource,
      services: useLogServices(ConnectorId.CloudWatchLogs, scope.range, scope.codes, on(ConnectorId.CloudWatchLogs)),
      codes: useStatusCodes(ConnectorId.CloudWatchLogs, scope.range, on(ConnectorId.CloudWatchLogs)),
    },
    {
      source: ConnectorId.LokiLogs as LogSource,
      services: useLogServices(ConnectorId.LokiLogs, scope.range, scope.codes, on(ConnectorId.LokiLogs)),
      codes: useStatusCodes(ConnectorId.LokiLogs, scope.range, on(ConnectorId.LokiLogs)),
    },
    {
      source: ConnectorId.NewRelicLogs as LogSource,
      services: useLogServices(ConnectorId.NewRelicLogs, scope.range, scope.codes, on(ConnectorId.NewRelicLogs)),
      codes: useStatusCodes(ConnectorId.NewRelicLogs, scope.range, on(ConnectorId.NewRelicLogs)),
    },
  ].filter((read) => on(read.source));
  const known =
    reads.length > 0 && reads.every((read) => read.codes.data)
      ? mergeCodes(reads.map((read) => read.codes.data ?? []))
      : null;
  const alerts = useAlerts();
  const open = (alerts.data ?? []).filter(
    (alert) =>
      !CLOSED.includes(alert.status) &&
      (source === 'all' || alert.connector === source) &&
      inMonitor(alert, scope.codes),
  );
  // The sources' lists first; then Services with open Alerts from earlier Scans but nothing in this range.
  const rows: ServiceRow[] = reads.flatMap((read) =>
    (read.services.data ?? []).map((one) => ({ source: read.source, name: one.name, errors: one.errors })),
  );
  // One pass over the Alerts, which run to thousands, rather than one per Service.
  const byService = new Map<string, AlertListItem[]>();
  for (const alert of open) {
    const key = `${alert.connector}:${alert.service.name}`;
    const list = byService.get(key);
    if (list) list.push(alert);
    else byService.set(key, [alert]);
  }
  const named = new Set(rows.map((row) => `${row.source}:${row.name}`));
  for (const [key, list] of byService) {
    const first = list[0];
    if (first && !named.has(key)) rows.push({ source: first.connector, name: first.service.name, errors: null });
  }
  return {
    inView,
    names: inView.length > 0 ? sourceNames(inView) : 'a log source',
    rows: ascending(rows, (row) => row.name),
    byService,
    known,
    codesError: reads.find((read) => read.codes.isError)?.codes.error,
    listError: reads.find((read) => read.services.isError)?.services.error,
    reading: reads.some((read) => read.services.isPending),
    allRead: reads.length > 0 && reads.every((read) => read.services.isSuccess),
    /** Services a Scan would read: those the sources list for the range. */
    scanCount: reads.reduce((total, read) => total + (read.services.data?.length ?? 0), 0),
  };
}

export type MonitorData = ReturnType<typeof useMonitorData>;
