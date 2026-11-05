import { type Alert, AlertStatus, SCAN_RANGES, ScanStatus, SEVERITIES, type Severity } from '@ops-console/shared';
import { useState } from 'react';
import { z } from 'zod';
import { Button, Spinner } from '../components/ui/button';
import { item } from '../components/ui/item';
import { PanelToggle } from '../components/ui/side-panel';
import { useAlerts, useDatadogServices, useScans, useStartScan, useStatusCodes } from '../lib/queries';
import { useStored } from '../lib/remember';
import { ascending } from '../lib/sort';
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
function Tiers({ alerts }: { alerts: Alert[] }) {
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

type Row = { name: string; errors: number | null };

const LINK = 'cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-accent-700 hover:text-accent-600';

/**
 * The Monitor's first column: the range and HTTP status codes to read, the Datadog Services with failing requests in
 * them across every env, and the Scan button. Picking a Service shows its logs and scans only it.
 */
export function ServicesPane({
  connected,
  scope,
  selected,
  onSelect,
  onCollapse,
}: {
  connected: boolean;
  scope: ScanScope;
  selected: string | null;
  onSelect: (name: string | null) => void;
  /** Folds the panel to its rail. */
  onCollapse: () => void;
}) {
  const listed = useDatadogServices(scope.range, scope.codes, connected);
  const known = useStatusCodes(scope.range, connected);
  const alerts = useAlerts();
  const scans = useScans();
  const scan = useStartScan();
  const [filter, setFilter] = useStored('monitor.services-filter', z.string(), '');
  // Services ticked to Scan; picking a row only shows its logs. A ticked one missing from this range stays ticked.
  const [ticked, setTicked] = useStored('monitor.ticked', z.array(z.string()), []);
  const [detail, setDetail] = useState(false);

  const open = (alerts.data ?? []).filter((alert) => !CLOSED.includes(alert.status) && inMonitor(alert, scope.codes));
  // Datadog's list first; then Services with open Alerts from earlier Scans but nothing in this range.
  const rows: Row[] = [...(listed.data ?? [])];
  // One pass over the Alerts, which run to thousands, rather than one per Service.
  const byService = new Map<string, Alert[]>();
  for (const alert of open) {
    const list = byService.get(alert.service.name);
    if (list) list.push(alert);
    else byService.set(alert.service.name, [alert]);
  }
  const named = new Set(rows.map((row) => row.name));
  for (const name of byService.keys()) if (!named.has(name)) rows.push({ name, errors: null });
  const top = Math.max(1, ...rows.map((row) => row.errors ?? 0));
  const needle = filter.trim().toLowerCase();
  const shown = ascending(
    needle ? rows.filter((row) => row.name.toLowerCase().includes(needle)) : rows,
    (row) => row.name,
  );
  const last = scans.data?.[0];
  const lastGood = scans.data?.find((row) => row.status === ScanStatus.Ok);
  const running = last?.status === ScanStatus.Running;
  const scanCount = listed.data?.length ?? 0;
  const toScan = ticked.filter((name) => rows.some((row) => row.name === name));
  const allTicked = shown.length > 0 && shown.every((row) => toScan.includes(row.name));
  const tick = (name: string) =>
    setTicked(ticked.includes(name) ? ticked.filter((other) => other !== name) : [...ticked, name]);
  const tickAll = () => {
    const names = shown.map((row) => row.name);
    setTicked(allTicked ? ticked.filter((name) => !names.includes(name)) : [...new Set([...ticked, ...names])]);
  };
  const scanTip = !connected
    ? 'Connect Datadog in Integrations'
    : running
      ? 'A Scan is running. Wait for it to finish.'
      : toScan.length === 0 && !selected && scanCount === 0
        ? 'No Services to Scan in this range'
        : 'Read the failing requests in Datadog now, group them into Alerts and mark each Route healthy, failing or rapid. The schedule also scans on its own.';
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
          title="Each Service in Datadog with failing requests in the range, across every env. Pick one to see its logs; tick it to Scan it."
        >
          Failing requests in Datadog, every env
        </p>
        <fieldset
          aria-label="Range"
          title="How far back the list, the counts and the next Scan read in Datadog"
          className="m-0 flex min-w-0 gap-0.5 rounded-lg border-0 bg-neutral-200 p-0.75"
        >
          {SCAN_RANGES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope.range === value}
              title={`Read the last ${value} of Datadog logs`}
              onClick={() => scope.pickRange(value)}
              className={`flex-1 cursor-pointer rounded-md border-0 py-1 font-mono text-xs transition-colors ${scope.range === value ? 'bg-card font-semibold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'}`}
            >
              {value}
            </button>
          ))}
        </fieldset>
        <div className="flex gap-1.5">
          {known.data && <StatusPicker known={known.data} scope={scope} />}
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
        {!known.data && (
          <span className="px-0.5 text-xs text-neutral-700">
            {!connected
              ? 'Datadog is not connected.'
              : known.isError
                ? `Could not read status codes: ${known.error.message}`
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
            const mine = byService.get(row.name) ?? [];
            const picked = selected === row.name;
            return (
              <li key={row.name} className="group relative">
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
        {listed.isPending && connected && (
          <p className="m-0 px-4 py-2 text-xs text-neutral-700">Reading Services from Datadog…</p>
        )}
        {listed.isError && (
          <p role="alert" className="m-0 px-4 py-2 text-xs text-accent-700">
            Could not read Services: {listed.error.message}
          </p>
        )}
        {listed.isSuccess && rows.length === 0 && (
          <p className="m-0 px-4 py-2 text-xs text-neutral-700">
            No failing requests in {scope.range} for these status codes.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2.5 border-t border-divider px-3.5 pt-3 pb-3.5">
        <Button
          variant="primary"
          className="w-full justify-center py-2 text-[13px]"
          disabled={!connected || scan.isPending || running || (toScan.length === 0 && !selected && scanCount === 0)}
          title={scanTip}
          onClick={() =>
            scan.mutate({
              service_id: null,
              window: scope.range,
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
        {scan.isError && (
          <span role="alert" className="text-xs text-accent-700">
            {scan.error.message}
          </span>
        )}
        {last && (last.status === ScanStatus.Failed || last.status === ScanStatus.RateLimited) ? (
          <span role="status" className="text-xs text-accent-700">
            The last Scan{' '}
            {last.status === ScanStatus.RateLimited ? 'hit a Datadog rate limit' : 'could not read Datadog'}.{' '}
            {lastGood?.finished_at ? `Last good one ${ago(lastGood.finished_at)}.` : 'No good Scan yet.'}
          </span>
        ) : (
          last?.finished_at && (
            <div className="flex flex-col gap-2 text-xs text-neutral-700">
              <div className="flex items-center gap-1.5">
                <span aria-hidden className="size-1.75 flex-none rounded-full bg-ok" />
                <span>Last Scan {ago(last.finished_at)}</span>
                <button
                  type="button"
                  aria-expanded={detail}
                  onClick={() => setDetail(!detail)}
                  title="What the last Scan read"
                  className="ml-auto flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs text-neutral-700 underline underline-offset-2 hover:text-text"
                >
                  {last.services
                    ? `${last.services.length} ${last.services.length === 1 ? 'Service' : 'Services'}`
                    : 'Every Service'}
                  <span aria-hidden>{detail ? '▴' : '▾'}</span>
                </button>
              </div>
              {detail && (
                <div className="flex max-h-24 flex-col gap-1.5 overflow-auto rounded-lg border border-line bg-card p-2">
                  <span className="font-mono">
                    {last.window_size} ·{' '}
                    {last.status_codes.length > 0 ? `HTTP ${last.status_codes.join(', ')}` : 'HTTP 400+'}
                  </span>
                  {last.services && (
                    <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
                      {last.services.map((name) => (
                        <li key={name} className="rounded bg-neutral-200 px-1.5 font-mono">
                          {name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
