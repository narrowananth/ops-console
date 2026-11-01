import { type Alert, AlertStatus, SCAN_RANGES, ScanStatus, SEVERITIES, type Severity } from '@ops-console/shared';
import { z } from 'zod';
import { Button, Spinner } from '../components/ui/button';
import { item } from '../components/ui/item';
import { useAlerts, useDatadogServices, useScans, useStartScan, useStatusCodes } from '../lib/queries';
import { useStored } from '../lib/remember';
import { ascending } from '../lib/sort';
import { ago, shown as inMonitor, type ScanScope } from './scan-scope';
import { StatusPicker } from './status-picker';

const CLOSED = [AlertStatus.Resolved, AlertStatus.Dismissed];
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

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
          <span key={severity} className="flex items-center gap-1 font-mono text-[10px] text-neutral-700">
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

/**
 * The Monitor's first column: the range and HTTP status codes to read, the Datadog Services with failing requests in
 * them across every env, and the Scan button. Picking a Service shows its logs and scans only it.
 */
export function ServicesPane({
  connected,
  scope,
  selected,
  onSelect,
}: {
  connected: boolean;
  scope: ScanScope;
  selected: string | null;
  onSelect: (name: string | null) => void;
}) {
  const listed = useDatadogServices(scope.range, scope.codes, connected);
  const known = useStatusCodes(scope.range, connected);
  const alerts = useAlerts();
  const scans = useScans();
  const scan = useStartScan();
  const [filter, setFilter] = useStored('monitor.services-filter', z.string(), '');
  // Services ticked to Scan; picking a row only shows its logs. A ticked one missing from this range stays ticked.
  const [ticked, setTicked] = useStored('monitor.ticked', z.array(z.string()), []);

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
  const someTicked = !allTicked && shown.some((row) => toScan.includes(row.name));
  const tick = (name: string) =>
    setTicked(ticked.includes(name) ? ticked.filter((other) => other !== name) : [...ticked, name]);
  const tickAll = () => {
    const names = shown.map((row) => row.name);
    setTicked(allTicked ? ticked.filter((name) => !names.includes(name)) : [...new Set([...ticked, ...names])]);
  };
  const box = 'absolute top-2.5 left-2.5 z-1 size-3.5 cursor-pointer accent-accent';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-divider px-3 py-3">
        <div className="flex items-baseline justify-between px-0.5">
          <h2 className="m-0 text-[13px] font-extrabold">Services</h2>
          <span className="text-[11px] text-neutral-700">Datadog requests failing, HTTP 400+</span>
        </div>
        <fieldset aria-label="Range" className="m-0 flex gap-0.5 rounded-lg border-0 bg-neutral-200 p-0.75">
          {SCAN_RANGES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope.range === value}
              onClick={() => scope.pickRange(value)}
              className={`flex-1 cursor-pointer rounded-md border-0 py-1 font-mono text-[11px] transition-colors ${scope.range === value ? 'bg-card font-bold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'}`}
            >
              {value}
            </button>
          ))}
        </fieldset>
        {known.data ? (
          <StatusPicker known={known.data} scope={scope} />
        ) : (
          <span className="px-0.5 text-[11px] text-neutral-700">
            {!connected
              ? 'Datadog is not connected.'
              : known.isError
                ? `Could not read status codes: ${known.error.message}`
                : 'Reading status codes…'}
          </span>
        )}
        {rows.length > 8 && (
          <input
            type="search"
            aria-label="Filter Services"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={`Filter ${rows.length} Services`}
            className="rounded-md border border-divider bg-bg px-2.5 py-1.5 text-xs text-text outline-none focus:border-accent-400"
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul aria-label="Services" className="m-0 flex list-none flex-col gap-0.5 p-1.5">
          <li className="relative">
            <input
              type="checkbox"
              aria-label="Tick every Service to Scan"
              checked={allTicked}
              ref={(input) => {
                if (input) input.indeterminate = someTicked;
              }}
              onChange={tickAll}
              className={box}
            />
            <button
              type="button"
              aria-current={selected === null}
              onClick={() => onSelect(null)}
              className={`flex w-full items-center gap-2 py-2 pr-2.5 pl-8 ${item(selected === null)}`}
            >
              <strong className="text-[12px]">All Services</strong>
              <span className="ml-auto font-mono text-[11px] text-neutral-700">{rows.length}</span>
            </button>
          </li>
          {shown.map((row) => {
            const mine = byService.get(row.name) ?? [];
            const picked = selected === row.name;
            return (
              <li key={row.name} className="relative">
                <input
                  type="checkbox"
                  aria-label={`Scan ${row.name}`}
                  checked={toScan.includes(row.name)}
                  onChange={() => tick(row.name)}
                  className={box}
                />
                <button
                  type="button"
                  aria-current={picked}
                  onClick={() => onSelect(row.name)}
                  className={`flex w-full flex-col gap-1 py-2 pr-2.5 pl-8 ${item(picked)}`}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="min-w-0 truncate text-[12px] font-semibold">{row.name}</span>
                    <span
                      className="ml-auto flex-none font-mono text-[11px] text-neutral-700"
                      title={row.errors === null ? 'None in this range' : `${row.errors} failing requests`}
                    >
                      {row.errors === null ? '0' : compact.format(row.errors)}
                    </span>
                  </span>
                  <span aria-hidden className="h-0.75 w-full overflow-hidden rounded-full bg-neutral-200">
                    <span
                      className="block h-full rounded-full bg-accent/60"
                      style={{ width: `${Math.max(2, ((row.errors ?? 0) / top) * 100)}%` }}
                    />
                  </span>
                  {mine.length > 0 && (
                    <span className="flex w-full items-center justify-end">
                      <Tiers alerts={mine} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {listed.isPending && connected && (
          <p className="m-0 px-4 py-2 text-[11px] text-neutral-700">Reading Services from Datadog…</p>
        )}
        {listed.isError && (
          <p role="alert" className="m-0 px-4 py-2 text-[11px] text-accent-700">
            Could not read Services: {listed.error.message}
          </p>
        )}
        {listed.isSuccess && rows.length === 0 && (
          <p className="m-0 px-4 py-2 text-[11px] text-neutral-700">
            No failing requests in {scope.range} for these status codes.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-divider px-3 py-3">
        <Button
          variant="primary"
          className="w-full justify-center py-1.5 text-xs"
          disabled={!connected || scan.isPending || running || (toScan.length === 0 && !selected && scanCount === 0)}
          title={connected ? undefined : 'Connect Datadog in Integrations'}
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
                ? `Scan ${toScan.length} ticked Services · ${scope.range}`
                : selected
                  ? `Scan ${selected} · ${scope.range}`
                  : `Scan ${scanCount} Services · ${scope.range}`}
        </Button>
        {toScan.length > 0 && (
          <button
            type="button"
            onClick={() => setTicked([])}
            className="cursor-pointer self-start border-0 bg-transparent p-0 text-[11px] text-neutral-700 underline hover:text-text"
          >
            Untick {toScan.length === 1 ? toScan[0] : `all ${toScan.length}`}
          </button>
        )}
        {scan.isError && (
          <span role="alert" className="text-[11px] text-accent-700">
            {scan.error.message}
          </span>
        )}
        {last && (last.status === ScanStatus.Failed || last.status === ScanStatus.RateLimited) ? (
          <span role="status" className="text-[11px] text-accent-700">
            The last Scan{' '}
            {last.status === ScanStatus.RateLimited ? 'hit a Datadog rate limit' : 'could not read Datadog'}.{' '}
            {lastGood?.finished_at ? `Last good one ${ago(lastGood.finished_at)}.` : 'No good Scan yet.'}
          </span>
        ) : (
          last?.finished_at && (
            <span className="text-[11px] text-neutral-700">
              Last Scan {ago(last.finished_at)}: {last.window_size} of{' '}
              {last.services ? last.services.join(', ') : 'every Service'},{' '}
              {last.status_codes.length > 0 ? `HTTP ${last.status_codes.join(', ')}` : 'HTTP 400+'}
            </span>
          )
        )}
      </div>
    </div>
  );
}
