import {
  type Alert,
  AlertStatus,
  type MonitorEnv,
  NO_ENV,
  SCAN_RANGES,
  ScanStatus,
  SEVERITIES,
  type Severity,
} from '@ops-console/shared';
import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button';
import { item, menu } from '../components/ui/item';
import { useAlerts, useDatadogServices, useScans, useStartScan } from '../lib/queries';
import { ascending } from '../lib/sort';
import { ago, envLabel, type ScanScope } from './scan-scope';

const CLOSED = [AlertStatus.Resolved, AlertStatus.Dismissed];
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

const TIER_DOT: Record<Severity, string> = {
  high: 'bg-accent',
  medium: 'bg-warn',
  low: 'bg-neutral-400',
};

/** The envs to read, as one field that opens a list of checkboxes. */
function EnvPicker({ known, scope }: { known: MonitorEnv[]; scope: ScanScope }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const summary =
    scope.envs.length === 0
      ? 'None picked'
      : byEnv(scope.envs, (env) => env)
          .map(envLabel)
          .join(', ');

  return (
    <div className="relative">
      {open && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="fixed inset-0 z-50 cursor-default"
          onClick={() => setOpen(false)}
        />
      )}
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Envs"
        onClick={() => setOpen(!open)}
        className={`flex w-full cursor-pointer items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-left text-xs shadow-sm transition-colors hover:border-neutral-400 ${open ? 'border-accent-400 shadow-[0_0_0_3px_var(--color-accent-100)]' : 'border-divider'}`}
      >
        <span className="flex-none text-neutral-700">Envs</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{summary}</span>
        <span className="flex-none rounded-full bg-neutral-200 px-1.5 font-mono text-[10px] text-neutral-700">
          {scope.envs.length}/{known.length}
        </span>
      </button>
      {open && (
        <fieldset className={`absolute top-full right-0 left-0 z-51 m-0 mt-1 max-h-80 overflow-auto ${menu}`}>
          <legend className="sr-only">Envs to read</legend>
          {byEnv(known, (env) => env.name).map((env) => (
            <label
              key={env.name}
              className={`flex items-center gap-2.5 px-2.5 py-1.5 ${item(scope.envs.includes(env.name))}`}
            >
              <input
                type="checkbox"
                checked={scope.envs.includes(env.name)}
                onChange={() => scope.toggleEnv(env.name)}
                className="size-3.5 flex-none cursor-pointer accent-accent"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-mono text-xs">{envLabel(env.name)}</span>
                {env.name === NO_ENV && <span className="text-[11px] text-neutral-700">Logs sent with no env tag</span>}
              </span>
              {env.configured && (
                <span className="rounded-full bg-neutral-200 px-1.5 text-[10px] text-neutral-700">default</span>
              )}
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

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

/** Envs A→Z, the logs with no env tag last. */
function byEnv<T>(items: readonly T[], name: (item: T) => string): T[] {
  return ascending(items, name).sort((a, b) => Number(name(a) === NO_ENV) - Number(name(b) === NO_ENV));
}

type Row = { name: string; envs: string[]; errors: number | null };

/**
 * The Monitor's first column: the range and envs to read, the Datadog Services with error or warn logs in them, and
 * the Scan button. Picking a Service shows its logs and scans only it.
 */
export function ServicesPane({
  connected,
  known,
  scope,
  selected,
  onSelect,
}: {
  connected: boolean;
  known: MonitorEnv[] | undefined;
  scope: ScanScope;
  selected: string | null;
  onSelect: (name: string | null) => void;
}) {
  const listed = useDatadogServices(scope.range, scope.envs, connected);
  const alerts = useAlerts();
  const scans = useScans();
  const scan = useStartScan();
  const [filter, setFilter] = useState('');

  const open = (alerts.data ?? []).filter(
    (alert) => !CLOSED.includes(alert.status) && scope.envs.includes(alert.service.env),
  );
  // Datadog's list first; then Services with open Alerts from earlier Scans but nothing in this range.
  const rows: Row[] = [...(listed.data ?? [])];
  for (const alert of open) {
    if (!rows.some((row) => row.name === alert.service.name)) {
      rows.push({ name: alert.service.name, envs: [alert.service.env], errors: null });
    }
  }
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-divider px-3 py-3">
        <div className="flex items-baseline justify-between px-0.5">
          <h2 className="m-0 text-[13px] font-extrabold">Services</h2>
          <span className="text-[11px] text-neutral-700">Datadog error and warn logs</span>
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
        {known ? (
          <EnvPicker known={known} scope={scope} />
        ) : (
          <span className="px-0.5 text-[11px] text-neutral-700">
            {connected ? 'Reading envs…' : 'Datadog is not connected.'}
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
          <li>
            <button
              type="button"
              aria-current={selected === null}
              onClick={() => onSelect(null)}
              className={`flex w-full items-center gap-2 px-2.5 py-2 ${item(selected === null)}`}
            >
              <strong className="text-[12px]">All Services</strong>
              <span className="ml-auto font-mono text-[11px] text-neutral-700">{rows.length}</span>
            </button>
          </li>
          {shown.map((row) => {
            const mine = open.filter((alert) => alert.service.name === row.name);
            const picked = selected === row.name;
            return (
              <li key={row.name}>
                <button
                  type="button"
                  aria-current={picked}
                  onClick={() => onSelect(row.name)}
                  className={`flex w-full flex-col gap-1 px-2.5 py-2 ${item(picked)}`}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="min-w-0 truncate text-[12px] font-semibold">{row.name}</span>
                    <span
                      className="ml-auto flex-none font-mono text-[11px] text-neutral-700"
                      title={row.errors === null ? 'None in this range' : `${row.errors} error and warn logs`}
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
                  <span className="flex w-full items-center gap-1.5">
                    {byEnv(row.envs, (env) => env).map((env) => (
                      <span key={env} className="rounded bg-neutral-200 px-1 font-mono text-[10px] text-neutral-700">
                        {envLabel(env)}
                      </span>
                    ))}
                    <span className="ml-auto">
                      <Tiers alerts={mine} />
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {listed.isPending && connected && scope.envs.length > 0 && (
          <p className="m-0 px-4 py-2 text-[11px] text-neutral-700">Reading Services from Datadog…</p>
        )}
        {listed.isError && (
          <p role="alert" className="m-0 px-4 py-2 text-[11px] text-accent-700">
            Could not read Services: {listed.error.message}
          </p>
        )}
        {listed.isSuccess && rows.length === 0 && (
          <p className="m-0 px-4 py-2 text-[11px] text-neutral-700">
            No error or warn logs in {scope.range} for these envs.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-divider px-3 py-3">
        <Button
          variant="primary"
          className="w-full justify-center py-1.5 text-xs"
          disabled={
            !connected || scan.isPending || running || scope.envs.length === 0 || (!selected && scanCount === 0)
          }
          title={connected ? undefined : 'Connect Datadog in Integrations'}
          onClick={() =>
            scan.mutate({
              service_id: null,
              window: scope.range,
              envs: scope.envs,
              ...(selected ? { services: [selected] } : {}),
            })
          }
        >
          {running
            ? 'Scanning…'
            : selected
              ? `Scan ${selected} · ${scope.range}`
              : `Scan ${scanCount} Services · ${scope.range}`}
        </Button>
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
              {last.services ? last.services.join(', ') : 'every Service'} in {last.envs.map(envLabel).join(', ')}
            </span>
          )
        )}
      </div>
    </div>
  );
}
