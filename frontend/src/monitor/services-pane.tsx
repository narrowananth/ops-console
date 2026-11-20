import {
  type AlertListItem,
  AlertStatus,
  CONNECTOR_NAMES,
  ConnectorId,
  LOG_SOURCES,
  type LogSource,
  SCAN_RANGES,
  type Scan,
  ScanStatus,
  SEVERITIES,
  type Severity,
  type StatusCodeCount,
} from '@ops-console/shared';
import { useState } from 'react';
import { z } from 'zod';
import { StopIcon } from '../agents/stop-run';
import { Button, Spinner } from '../components/ui/button';
import { item } from '../components/ui/item';
import { PanelToggle } from '../components/ui/side-panel';
import { useAlerts, useCancelScan, useLogServices, useScans, useStartScan, useStatusCodes } from '../lib/queries';
import { useStored } from '../lib/remember';
import { ascending } from '../lib/sort';
import { CONNECT_A_SOURCE, SOURCE_LABEL, type SourceFilter, SourceLabel, sourceNames } from './log-source';
import { ago, shown as inMonitor, type ScanScope } from './scan-scope';
import { StatusPicker } from './status-picker';

const CLOSED = [AlertStatus.Resolved, AlertStatus.Dismissed];
const compact = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const TIER_DOT: Record<Severity, string> = {
  high: 'bg-accent',
  medium: 'bg-warn',
  low: 'bg-neutral-400',
};

/** Open Alerts of one Service, by tier, as coloured counts. */
function Tiers({ alerts }: { alerts: AlertListItem[] }) {
  if (alerts.length === 0) return null;
  return (
    <span className="flex items-center gap-1.5">
      {SEVERITIES.map((severity) => {
        const count = alerts.filter((alert) => alert.severity === severity).length;
        if (count === 0) return null;
        return (
          <span
            key={severity}
            title={`${count} open ${severity} ${count === 1 ? 'Alert' : 'Alerts'}`}
            className="flex items-center gap-1 font-mono text-xs text-neutral-700"
          >
            <span aria-hidden className={`size-1.5 rounded-full ${TIER_DOT[severity]}`} />
            {count}
            <span className="sr-only">{severity}</span>
          </span>
        );
      })}
    </span>
  );
}

type Row = { source: LogSource; name: string; errors: number | null };

/** Counts of the same status code from several sources add up. */
function mergeCodes(lists: StatusCodeCount[][]): StatusCodeCount[] {
  const counts = new Map<number, number>();
  for (const entry of lists.flat()) counts.set(entry.code, (counts.get(entry.code) ?? 0) + entry.count);
  return [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
}

const LINK = 'cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-accent-700 hover:text-accent-600';

/**
 * The Monitor's first column: the range and HTTP status codes to read, the Services with failing requests in them
 * across every env, from each connected log source, and the Scan button. Picking a Service shows its logs and scans only it.
 */
export function ServicesPane({
  connected,
  source,
  scope,
  selected,
  onSelect,
  onCollapse,
}: {
  /** The log sources connected now. */
  connected: LogSource[];
  source: SourceFilter;
  scope: ScanScope;
  selected: string | null;
  onSelect: (name: string | null) => void;
  /** Folds the panel to its rail. */
  onCollapse: () => void;
}) {
  const inView = connected.filter((one) => source === 'all' || one === source);
  const reads = [
    {
      source: ConnectorId.Datadog as LogSource,
      services: useLogServices(ConnectorId.Datadog, scope.range, scope.codes, inView.includes(ConnectorId.Datadog)),
      codes: useStatusCodes(ConnectorId.Datadog, scope.range, inView.includes(ConnectorId.Datadog)),
    },
    {
      source: ConnectorId.OtelLogs as LogSource,
      services: useLogServices(ConnectorId.OtelLogs, scope.range, scope.codes, inView.includes(ConnectorId.OtelLogs)),
      codes: useStatusCodes(ConnectorId.OtelLogs, scope.range, inView.includes(ConnectorId.OtelLogs)),
    },
    {
      source: ConnectorId.CloudWatchLogs as LogSource,
      services: useLogServices(
        ConnectorId.CloudWatchLogs,
        scope.range,
        scope.codes,
        inView.includes(ConnectorId.CloudWatchLogs),
      ),
      codes: useStatusCodes(ConnectorId.CloudWatchLogs, scope.range, inView.includes(ConnectorId.CloudWatchLogs)),
    },
    {
      source: ConnectorId.LokiLogs as LogSource,
      services: useLogServices(ConnectorId.LokiLogs, scope.range, scope.codes, inView.includes(ConnectorId.LokiLogs)),
      codes: useStatusCodes(ConnectorId.LokiLogs, scope.range, inView.includes(ConnectorId.LokiLogs)),
    },
    {
      source: ConnectorId.NewRelicLogs as LogSource,
      services: useLogServices(
        ConnectorId.NewRelicLogs,
        scope.range,
        scope.codes,
        inView.includes(ConnectorId.NewRelicLogs),
      ),
      codes: useStatusCodes(ConnectorId.NewRelicLogs, scope.range, inView.includes(ConnectorId.NewRelicLogs)),
    },
  ].filter((read) => inView.includes(read.source));
  const known =
    reads.every((read) => read.codes.data) && reads.length > 0
      ? mergeCodes(reads.map((read) => read.codes.data ?? []))
      : null;
  const codesError = reads.find((read) => read.codes.isError)?.codes.error;
  const listError = reads.find((read) => read.services.isError)?.services.error;
  const names = inView.length > 0 ? sourceNames(inView) : 'a log source';
  const alerts = useAlerts();
  const scans = useScans();
  const scan = useStartScan();
  const cancel = useCancelScan();
  const [filter, setFilter] = useStored('monitor.services-filter', z.string(), '');
  // Services ticked to Scan; picking a row only shows its logs. A ticked one missing from this range stays ticked.
  const [ticked, setTicked] = useStored('monitor.ticked', z.array(z.string()), []);

  const open = (alerts.data ?? []).filter(
    (alert) =>
      !CLOSED.includes(alert.status) &&
      (source === 'all' || alert.connector === source) &&
      inMonitor(alert, scope.codes),
  );
  // The sources' lists first; then Services with open Alerts from earlier Scans but nothing in this range.
  const rows: Row[] = reads.flatMap((read) =>
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
  const top = Math.max(1, ...rows.map((row) => row.errors ?? 0));
  const needle = filter.trim().toLowerCase();
  const shown = ascending(
    needle ? rows.filter((row) => row.name.toLowerCase().includes(needle)) : rows,
    (row) => row.name,
  );
  // The newest Scan of each source in view.
  const latest = LOG_SOURCES.filter((one) => source === 'all' || one === source).flatMap((one) => {
    const newest = scans.data?.find((row) => row.connector === one);
    return newest ? [newest] : [];
  });
  const runningScans = latest.filter((row) => row.status === ScanStatus.Running);
  const running = runningScans.length > 0;
  const scanCount = reads.reduce((total, read) => total + (read.services.data?.length ?? 0), 0);
  const toScan = ticked.filter((name) => rows.some((row) => row.name === name));
  const allTicked = shown.length > 0 && shown.every((row) => toScan.includes(row.name));
  const tick = (name: string) =>
    setTicked(ticked.includes(name) ? ticked.filter((other) => other !== name) : [...ticked, name]);
  const tickAll = () => {
    const names = shown.map((row) => row.name);
    setTicked(allTicked ? ticked.filter((name) => !names.includes(name)) : [...new Set([...ticked, ...names])]);
  };
  const scanTip =
    inView.length === 0
      ? CONNECT_A_SOURCE
      : running
        ? 'A Scan is running. Wait for it to finish.'
        : toScan.length === 0 && !selected && scanCount === 0
          ? 'No Services to Scan in this range'
          : `Read the failing requests in ${names} now, group them into Alerts and mark each Route healthy, failing or rapid. The schedule also scans on its own.`;
  // The boxes show on hover, and on every row once one is ticked.
  const box = `absolute top-2.5 left-2.5 z-1 size-3.5 cursor-pointer accent-accent focus-visible:opacity-100 ${toScan.length > 0 ? '' : 'opacity-0 group-hover:opacity-100'}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2.5 border-b border-divider px-3.5 py-3.5">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-extrabold tracking-tight">Services</h2>
          <span className="rounded-full bg-neutral-200 px-1.75 font-mono text-xs font-semibold text-neutral-700">
            {rows.length}
          </span>
          <div className="ml-auto flex h-7">
            <PanelToggle open panel="Services panel" onToggle={onCollapse} />
          </div>
        </div>
        <p
          className="m-0 -mt-1.5 text-xs text-neutral-700"
          title={`Each Service in ${names} with failing requests in the range, across every env. Pick one to see its logs; tick it to Scan it.`}
        >
          Failing requests in {names}, every env
        </p>
        <fieldset
          aria-label="Range"
          title={`How far back the list, the counts and the next Scan read in ${names}`}
          className="m-0 flex min-w-0 gap-0.5 rounded-lg border-0 bg-neutral-200 p-0.75"
        >
          {SCAN_RANGES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope.range === value}
              title={`Read the last ${value} of logs from ${names}`}
              onClick={() => scope.pickRange(value)}
              className={`flex-1 cursor-pointer rounded-md border-0 py-1 font-mono text-xs transition-colors ${scope.range === value ? 'bg-card font-semibold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'}`}
            >
              {value}
            </button>
          ))}
        </fieldset>
        <div className="flex gap-1.5">
          {known && <StatusPicker known={known} scope={scope} from={names} />}
          {rows.length > 8 && (
            <input
              type="search"
              aria-label="Filter Services"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={`Filter ${rows.length}`}
              className="min-w-0 flex-1 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-text outline-none focus:border-accent-400"
            />
          )}
        </div>
        {!known && (
          <span className="px-0.5 text-xs text-neutral-700">
            {inView.length === 0
              ? 'No log source is connected.'
              : codesError
                ? `Could not read status codes: ${codesError.message}`
                : 'Reading status codes…'}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-1 px-2 pt-2">
          <button
            type="button"
            aria-current={selected === null}
            onClick={() => onSelect(null)}
            className={`flex w-full items-center gap-2 px-2.5 py-2 ${item(selected === null)}`}
          >
            <strong className="text-[13px]">All Services</strong>
            <span className="ml-auto font-mono text-xs text-neutral-700">{rows.length}</span>
          </button>
          {shown.length > 0 && (
            <div className="flex items-center justify-between px-2.5 pt-1.5 text-xs text-neutral-700">
              {toScan.length > 0 ? (
                <strong className="font-semibold text-text">{toScan.length} ticked</strong>
              ) : (
                <span>Tick Services to Scan</span>
              )}
              <span className="flex gap-2.5">
                {!allTicked && (
                  <button type="button" onClick={tickAll} className={LINK} title="Tick every Service shown">
                    Tick all
                  </button>
                )}
                {toScan.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setTicked([])}
                    className={LINK}
                    title="Clear the ticks. The Scan then reads the picked Service, or every listed one."
                  >
                    Clear
                  </button>
                )}
              </span>
            </div>
          )}
        </div>
        <ul aria-label="Services" className="m-0 flex list-none flex-col gap-px p-2">
          {shown.map((row) => {
            const mine = byService.get(`${row.source}:${row.name}`) ?? [];
            const picked = selected === row.name;
            return (
              <li key={`${row.source}:${row.name}`} className="group relative">
                <input
                  type="checkbox"
                  aria-label={`Scan ${row.name}`}
                  title={`Tick to add ${row.name} to the next Scan. Clicking the name only shows its logs.`}
                  checked={toScan.includes(row.name)}
                  onChange={() => tick(row.name)}
                  className={box}
                />
                <button
                  type="button"
                  aria-current={picked}
                  onClick={() => onSelect(row.name)}
                  className={`flex w-full flex-col gap-1.5 py-2 pr-2.5 pl-8 ${item(picked)}`}
                >
                  <span className="flex w-full items-baseline gap-2">
                    <span className="min-w-0 truncate text-[13px] font-semibold">{row.name}</span>
                    <SourceLabel source={row.source} />
                    <span
                      className="ml-auto flex-none font-mono text-xs text-neutral-700"
                      title={
                        row.errors === null
                          ? 'No failing requests in this range. It is listed for its open Alerts from earlier Scans.'
                          : `${row.errors} failing requests in the last ${scope.range}`
                      }
                    >
                      {row.errors === null ? '0' : compact.format(row.errors)}
                    </span>
                  </span>
                  <span className="flex h-3 w-full items-center gap-2.5">
                    <span aria-hidden className="h-1 flex-1 overflow-hidden rounded-full bg-neutral-300/70">
                      <span
                        className="block h-full rounded-full bg-accent/65"
                        style={{
                          width: `${Math.max(2, ((row.errors ?? 0) / top) * 100)}%`,
                        }}
                      />
                    </span>
                    <Tiers alerts={mine} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {reads.some((read) => read.services.isPending) && (
          <p className="m-0 px-4 py-2 text-xs text-neutral-700">Reading Services from {names}…</p>
        )}
        {listError && (
          <p role="alert" className="m-0 px-4 py-2 text-xs text-accent-700">
            Could not read Services: {listError.message}
          </p>
        )}
        {reads.length > 0 && reads.every((read) => read.services.isSuccess) && rows.length === 0 && (
          <p className="m-0 px-4 py-2 text-xs text-neutral-700">
            No failing requests in {scope.range} for these status codes.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2.5 border-t border-divider px-3.5 pt-3 pb-3.5">
        <div className="flex gap-2">
          <Button
            variant="primary"
            className="min-w-0 flex-1 justify-center py-2 text-[13px]"
            disabled={
              inView.length === 0 || scan.isPending || running || (toScan.length === 0 && !selected && scanCount === 0)
            }
            title={scanTip}
            onClick={() =>
              scan.mutate({
                service_id: null,
                window: scope.range,
                // Left out, the Scan reads every connected source.
                ...(source !== 'all' ? { connector: source } : {}),
                ...(scope.codes.length > 0 ? { status_codes: scope.codes } : {}),
                // Ticked Services first; else the picked one; else every listed one.
                ...(toScan.length > 0 ? { services: toScan } : selected ? { services: [selected] } : {}),
              })
            }
          >
            {running && <Spinner />}
            {running
              ? 'Scanning…'
              : toScan.length === 1
                ? `Scan ${toScan[0]} · ${scope.range}`
                : toScan.length > 1
                  ? `Scan ${toScan.length} ticked · ${scope.range}`
                  : selected
                    ? `Scan ${selected} · ${scope.range}`
                    : `Scan ${scanCount} Services · ${scope.range}`}
          </Button>
          {running && (
            <Button
              title="Stop the Scan now. What it read so far is dropped."
              className="flex-none py-2 text-[13px]"
              disabled={cancel.isPending}
              onClick={() => {
                for (const row of runningScans) cancel.mutate(row.id);
              }}
            >
              {cancel.isPending ? <Spinner /> : <StopIcon />}
              Stop
            </Button>
          )}
        </div>
        {(scan.isError || cancel.isError) && (
          <span role="alert" className="text-xs text-accent-700">
            {(scan.error ?? cancel.error)?.message}
          </span>
        )}
        {latest.map((row) => (
          <ScanStatusLine
            key={row.id}
            scan={row}
            named={latest.length > 1}
            lastGood={scans.data?.find((one) => one.connector === row.connector && one.status === ScanStatus.Ok)}
          />
        ))}
      </div>
    </div>
  );
}

/** How the newest Scan of one source went: when it finished and what it read, or why it did not. */
function ScanStatusLine({ scan, named, lastGood }: { scan: Scan; named: boolean; lastGood: Scan | undefined }) {
  const [detail, setDetail] = useState(false);
  const label = named ? `${SOURCE_LABEL[scan.connector]} · ` : '';
  const failed =
    scan.status === ScanStatus.Failed || scan.status === ScanStatus.RateLimited || scan.status === ScanStatus.Cancelled;
  if (failed) {
    return (
      <span role="status" className="text-xs text-accent-700">
        The last {named ? `${SOURCE_LABEL[scan.connector]} ` : ''}Scan{' '}
        {scan.status === ScanStatus.RateLimited
          ? `hit a ${CONNECTOR_NAMES[scan.connector]} rate limit`
          : scan.status === ScanStatus.Cancelled
            ? 'was stopped'
            : `could not read ${CONNECTOR_NAMES[scan.connector]}`}
        . {lastGood?.finished_at ? `Last good one ${ago(lastGood.finished_at)}.` : 'No good Scan yet.'}
      </span>
    );
  }
  if (!scan.finished_at) return null;
  return (
    <div className="flex flex-col gap-2 text-xs text-neutral-700">
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="size-1.75 flex-none rounded-full bg-ok" />
        <span>
          {label}Last Scan {ago(scan.finished_at)}
        </span>
        <button
          type="button"
          aria-expanded={detail}
          onClick={() => setDetail(!detail)}
          title="What the last Scan read"
          className="ml-auto flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs text-neutral-700 underline underline-offset-2 hover:text-text"
        >
          {scan.services
            ? `${scan.services.length} ${scan.services.length === 1 ? 'Service' : 'Services'}`
            : 'Every Service'}
          <span aria-hidden>{detail ? '▴' : '▾'}</span>
        </button>
      </div>
      {scan.notes.length > 0 && (
        <ul aria-label="Scan notes" className="m-0 flex list-none flex-col gap-0.5 p-0 text-accent-700">
          {scan.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {detail && (
        <div className="flex max-h-24 flex-col gap-1.5 overflow-auto rounded-lg border border-line bg-card p-2">
          <span className="font-mono">
            {scan.window_size} · {scan.status_codes.length > 0 ? `HTTP ${scan.status_codes.join(', ')}` : 'HTTP 400+'}
          </span>
          {scan.services && (
            <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
              {scan.services.map((name) => (
                <li key={name} className="rounded bg-neutral-200 px-1.5 font-mono">
                  {name}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
