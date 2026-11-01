import { type Alert, AlertStatus, type ScanWindow, SEVERITIES, type Severity } from '@ops-console/shared';
import { useState } from 'react';
import { Empty } from '../components/ui/empty';
import { item } from '../components/ui/item';
import { useAlerts } from '../lib/queries';
import { ago, envLabel } from './scan-scope';
import { SEVERITY_LABEL, SeverityBadge } from './severity';

const CLOSED = [AlertStatus.Resolved, AlertStatus.Dismissed];

function Row({
  alert,
  selected,
  showService,
  onSelect,
}: {
  alert: Alert;
  selected: boolean;
  showService: boolean;
  onSelect: () => void;
}) {
  const where = alert.route ? `${alert.route.method} ${alert.route.path}` : null;
  return (
    <li>
      <button
        type="button"
        aria-current={selected}
        onClick={onSelect}
        className={`flex w-full flex-col gap-1 px-3 py-2.5 text-left ${item(selected)}`}
      >
        <span className="flex items-center gap-2 text-[11px]">
          <SeverityBadge severity={alert.severity} />
          {showService && <strong className="min-w-0 truncate text-[12px]">{alert.service.name}</strong>}
          <span className="font-mono text-neutral-700">{envLabel(alert.service.env)}</span>
          <span className="ml-auto flex-none whitespace-nowrap text-neutral-700">
            ×{alert.event_count} · {ago(alert.last_seen_at)}
          </span>
        </span>
        <span className="line-clamp-2 font-mono text-[12px] break-all">{alert.log_line || alert.title}</span>
        <span className="flex items-center gap-2 text-[11px] text-neutral-700">
          {where && <span className="truncate font-mono">{where}</span>}
          {alert.status !== AlertStatus.Open && (
            <span className="ml-auto flex-none rounded-full bg-neutral-200 px-1.75 font-mono text-[10px]">
              {alert.status.replace('_', ' ')}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** The Monitor's second column: the logs a Scan raised as Alerts, for one Service or all, split into tiers. */
export function LogsPane({
  service,
  envs,
  range,
  selected,
  onSelect,
}: {
  service: string | null;
  envs: string[];
  range: ScanWindow;
  selected: string | null;
  onSelect: (alertId: string) => void;
}) {
  const alerts = useAlerts();
  const [tier, setTier] = useState<Severity | 'all'>('all');
  const [showClosed, setShowClosed] = useState(false);

  const inScope = (alerts.data ?? []).filter(
    (alert) =>
      (service === null || alert.service.name === service) &&
      envs.includes(alert.service.env) &&
      (showClosed || !CLOSED.includes(alert.status)),
  );
  const counts = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, inScope.filter((alert) => alert.severity === severity).length]),
  ) as Record<Severity, number>;
  // Highest tier first; within a tier the API's order, newest sighting first.
  const shown = (tier === 'all' ? inScope : inScope.filter((alert) => alert.severity === tier))
    .map((alert, index) => ({ alert, index }))
    .sort((a, b) => SEVERITIES.indexOf(a.alert.severity) - SEVERITIES.indexOf(b.alert.severity) || a.index - b.index)
    .map(({ alert }) => alert);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline gap-2 border-b border-divider px-4 pt-3 pb-2">
        <h2 className="m-0 min-w-0 truncate text-[13px] font-extrabold">{service ?? 'All Services'}</h2>
        <span className="flex-none text-[11px] text-neutral-700">logs</span>
      </div>
      <div role="tablist" aria-label="Severity" className="flex gap-1 border-b border-divider px-3 py-2">
        {(['all', ...SEVERITIES] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tier === value}
            onClick={() => setTier(value)}
            className={`cursor-pointer rounded-md border-0 px-2.5 py-1 text-xs transition-colors ${tier === value ? 'bg-text font-bold text-bg' : 'bg-transparent text-neutral-700 hover:bg-neutral-200 hover:text-text'}`}
          >
            {value === 'all' ? 'All' : SEVERITY_LABEL[value]}{' '}
            <span className="font-mono text-[11px] opacity-75">{value === 'all' ? inScope.length : counts[value]}</span>
          </button>
        ))}
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-neutral-700">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={() => setShowClosed(!showClosed)}
            className="size-3.5 cursor-pointer accent-accent"
          />
          Closed
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {alerts.isError ? (
          <Empty>Could not read Alerts: {alerts.error.message}</Empty>
        ) : alerts.isPending ? (
          <Empty>Reading Alerts…</Empty>
        ) : shown.length === 0 ? (
          <Empty>
            {inScope.length > 0
              ? 'None here.'
              : service
                ? `No logs from ${service} yet. Scan it for the last ${range}.`
                : 'No logs yet. Pick a Service or Scan them all.'}
          </Empty>
        ) : (
          <ul aria-label="Logs" className="m-0 flex list-none flex-col gap-0.5 p-1.5">
            {shown.map((alert) => (
              <Row
                key={alert.id}
                alert={alert}
                selected={selected === alert.id}
                showService={service === null}
                onSelect={() => onSelect(alert.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
