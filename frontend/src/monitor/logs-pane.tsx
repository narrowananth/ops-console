import { type Alert, AlertStatus, type ScanWindow, SEVERITIES, type Severity } from '@ops-console/shared';
import { z } from 'zod';
import { Empty } from '../components/ui/empty';
import { item } from '../components/ui/item';
import { useAlerts } from '../lib/queries';
import { useStored } from '../lib/remember';
import { ago, shown as inMonitor } from './scan-scope';
import { SEVERITY_LABEL, SeverityBadge } from './severity';
import { StatusBadge } from './status-picker';

/** What each Alert status means and what comes next, shown on hover of its chip. */
export const STATUS_TIP: Record<AlertStatus, string> = {
  [AlertStatus.Open]: 'Open: a Scan raised it. Verify it to have the agent explain it from the code.',
  [AlertStatus.Verifying]: 'Verifying: the agent is following the log through the code and writing a Report.',
  [AlertStatus.Verified]:
    'Verified: the Report is ready. Read it, then confirm it as a bug or improvement, or dismiss it.',
  [AlertStatus.Fixing]: 'Fixing: the agent is changing the code on a fix branch and testing it.',
  [AlertStatus.PrOpen]: 'PR open: the Fix is pushed and waits for review. Merging the PR resolves the Alert.',
  [AlertStatus.Resolved]: 'Resolved: the PR was merged. A new failure after a healthy Scan reopens it as a Regression.',
  [AlertStatus.Dismissed]:
    'Dismissed: you set it aside. A new failure after a healthy Scan reopens it as a Regression.',
};

const TAB_TIP: Record<Severity | 'all', string> = {
  all: 'Every Alert in view, highest tier first',
  high: 'Only High Alerts: errors reached the rapid threshold in one 10-minute stretch',
  medium: 'Only Medium Alerts: errors per hour reached the failing threshold',
  low: 'Only Low Alerts: failing below the Medium and High thresholds',
};

const CLOSED = [AlertStatus.Resolved, AlertStatus.Dismissed];

/** Rows drawn at a time. A Scan can raise more than a thousand Alerts; drawing them all makes every click slow. */
export const LOGS_PAGE = 100;

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
          {alert.http_status !== null && <StatusBadge code={alert.http_status} />}
          <span
            className="ml-auto flex-none whitespace-nowrap text-neutral-700"
            title={`Seen ${alert.event_count} ${alert.event_count === 1 ? 'time' : 'times'}, last ${ago(alert.last_seen_at)}`}
          >
            ×{alert.event_count} · {ago(alert.last_seen_at)}
          </span>
        </span>
        <span className="line-clamp-2 font-mono text-[12px] break-all">{alert.log_line || alert.title}</span>
        <span className="flex items-center gap-2 text-[11px] text-neutral-700">
          {where && (
            <span className="truncate font-mono" title={`The Route that failed: ${where}`}>
              {where}
            </span>
          )}
          {alert.status !== AlertStatus.Open && (
            <span
              title={STATUS_TIP[alert.status]}
              className="ml-auto flex-none rounded-full bg-neutral-200 px-1.75 font-mono text-[10px]"
            >
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
  codes,
  range,
  selected,
  onSelect,
}: {
  service: string | null;
  codes: number[];
  range: ScanWindow;
  selected: string | null;
  onSelect: (alertId: string) => void;
}) {
  const alerts = useAlerts();
  const [tier, setTier] = useStored<Severity | 'all'>('monitor.tier', z.enum(['all', ...SEVERITIES]), 'all');
  const [showClosed, setShowClosed] = useStored('monitor.closed', z.boolean(), false);
  // How many rows are drawn, for the list as it is now picked; a new pick starts at one page again.
  const view = `${service}|${tier}|${showClosed}|${codes.join(',')}`;
  const [paged, setPaged] = useStored(
    'monitor.logs-shown',
    z.object({ view: z.string(), limit: z.number().int().positive() }),
    { view, limit: LOGS_PAGE },
  );

  const inScope = (alerts.data ?? []).filter(
    (alert) =>
      (service === null || alert.service.name === service) &&
      inMonitor(alert, codes) &&
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
  const picked = selected === null ? -1 : shown.findIndex((alert) => alert.id === selected);
  // The open Alert stays drawn even when it sits past the pages shown.
  const limit = Math.max(paged.view === view ? paged.limit : LOGS_PAGE, picked + 1);
  const drawn = shown.slice(0, limit);
  const left = shown.length - drawn.length;

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
            title={TAB_TIP[value]}
            onClick={() => setTier(value)}
            className={`cursor-pointer rounded-md border-0 px-2.5 py-1 text-xs transition-colors ${tier === value ? 'bg-text font-bold text-bg' : 'bg-transparent text-neutral-700 hover:bg-neutral-200 hover:text-text'}`}
          >
            {value === 'all' ? 'All' : SEVERITY_LABEL[value]}{' '}
            <span className="font-mono text-[11px] opacity-75">{value === 'all' ? inScope.length : counts[value]}</span>
          </button>
        ))}
        <label
          className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-neutral-700"
          title="Also show resolved and dismissed Alerts"
        >
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
            {drawn.map((alert) => (
              <Row
                key={alert.id}
                alert={alert}
                selected={selected === alert.id}
                showService={service === null}
                onSelect={() => onSelect(alert.id)}
              />
            ))}
            {left > 0 && (
              <li className="px-1.5 pt-1 pb-2">
                <button
                  type="button"
                  onClick={() => setPaged({ view, limit: limit + LOGS_PAGE })}
                  className="w-full cursor-pointer rounded-md border border-divider bg-card px-3 py-2 text-xs font-semibold text-text shadow-sm hover:bg-neutral-200"
                >
                  Show {Math.min(LOGS_PAGE, left)} more{' '}
                  <span className="font-mono font-normal text-neutral-700">
                    · {drawn.length} of {shown.length}
                  </span>
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
