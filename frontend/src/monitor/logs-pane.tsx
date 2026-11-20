import {
  type AlertListItem,
  AlertStatus,
  CONNECTOR_NAMES,
  LOG_SOURCES,
  type LogSource,
  type ScanWindow,
  SEVERITIES,
  type Severity,
} from '@ops-console/shared';
import { Fragment } from 'react';
import { z } from 'zod';
import { Empty } from '../components/ui/empty';
import { item } from '../components/ui/item';
import { useAlerts, useClosedAlerts } from '../lib/queries';
import { useStored } from '../lib/remember';
import { SOURCE_LABEL, type SourceFilter, SourceLabel } from './log-source';
import { FreshnessNote, MergeNote } from './prod-notes';
import { ago, shown as inMonitor } from './scan-scope';
import { SEVERITY_LABEL } from './severity';
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

/** Every word of `needle` sits in the Alert's route, message, title, status code, Service or status. */
function matches(alert: AlertListItem, needle: string): boolean {
  const text = [
    alert.route ? `${alert.route.method} ${alert.route.path}` : '',
    alert.log_line,
    alert.title,
    alert.http_status ?? '',
    alert.service.name,
    alert.status.replace('_', ' '),
  ]
    .join('\n')
    .toLowerCase();
  return needle.split(/\s+/).every((word) => text.includes(word));
}

/** Rows drawn at a time. A Scan can raise more than a thousand Alerts; drawing them all makes every click slow. */
export const LOGS_PAGE = 100;

const TIER_BAR: Record<Severity, string> = {
  high: 'bg-accent',
  medium: 'bg-warn',
  low: 'bg-neutral-400',
};

function Row({
  alert,
  selected,
  showService,
  onSelect,
}: {
  alert: AlertListItem;
  selected: boolean;
  showService: boolean;
  onSelect: () => void;
}) {
  const route = alert.route;
  return (
    <li>
      <button
        type="button"
        aria-current={selected}
        onClick={onSelect}
        className={`relative flex w-full flex-col gap-1 py-2.25 pr-2.5 pl-3.5 text-left ${item(selected)}`}
      >
        <span
          aria-hidden
          className={`absolute top-2.5 bottom-2.5 left-1 w-0.75 rounded-full ${TIER_BAR[alert.severity]}`}
        />
        <span className="sr-only">{SEVERITY_LABEL[alert.severity]}</span>
        <span className="flex w-full items-baseline gap-2">
          {route ? (
            <>
              <span className="flex-none font-mono text-[11px] font-semibold text-neutral-700">{route.method}</span>
              <span
                className="min-w-0 truncate font-mono text-[12.5px] font-semibold"
                title={`The Route that failed: ${route.method} ${route.path}`}
              >
                {route.path}
              </span>
            </>
          ) : (
            <span className="min-w-0 truncate text-[13px] font-semibold">{alert.title}</span>
          )}
          <span
            className="ml-auto flex-none text-xs whitespace-nowrap text-neutral-700"
            title={`Last seen ${new Date(alert.last_seen_at).toLocaleString()}`}
          >
            {ago(alert.last_seen_at)}
          </span>
        </span>
        <span className="flex w-full items-center gap-2 text-xs text-neutral-700">
          {showService && <strong className="min-w-0 truncate font-semibold text-text">{alert.service.name}</strong>}
          <SourceLabel source={alert.connector} />
          {alert.http_status !== null && <StatusBadge code={alert.http_status} />}
          <span
            className="ml-auto flex-none font-mono"
            title={`Seen ${alert.event_count} ${alert.event_count === 1 ? 'time' : 'times'}`}
          >
            ×{alert.event_count}
          </span>
          {alert.status !== AlertStatus.Open && (
            <span
              title={STATUS_TIP[alert.status]}
              className="flex-none rounded-full bg-neutral-200 px-1.75 font-mono text-[11px]"
            >
              {alert.status.replace('_', ' ')}
            </span>
          )}
        </span>
        <span className="line-clamp-2 font-mono text-[11.5px] leading-snug break-all text-neutral-700">
          {alert.log_line || alert.title}
        </span>
        <span className="flex items-center gap-2 text-xs empty:hidden">
          <FreshnessNote alert={alert} />
          <MergeNote alert={alert} />
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
  sources,
  down,
  source,
  onSource,
}: {
  service: string | null;
  codes: number[];
  range: ScanWindow;
  selected: string | null;
  onSelect: (alertId: string) => void;
  /** The log sources connected now. */
  sources: LogSource[];
  /** The log sources that stopped answering, with the check's reason. */
  down: { source: LogSource; reason: string | null }[];
  source: SourceFilter;
  onSource: (source: SourceFilter) => void;
}) {
  const alerts = useAlerts();
  const [tier, setTier] = useStored<Severity | 'all'>('monitor.tier', z.enum(['all', ...SEVERITIES]), 'all');
  const [showClosed, setShowClosed] = useStored('monitor.closed', z.boolean(), false);
  // Resolved and dismissed Alerts are read a page at a time, only once the operator asks for them.
  const closed = useClosedAlerts(showClosed);
  const listed = showClosed
    ? [...(alerts.data ?? []), ...(closed.data?.pages.flatMap((page) => page.data) ?? [])].sort((a, b) =>
        b.last_seen_at.localeCompare(a.last_seen_at),
      )
    : (alerts.data ?? []);
  const [query, setQuery] = useStored('monitor.logs-search', z.string(), '');
  const needle = query.trim().toLowerCase();
  // How many rows are drawn, for the list as it is now picked; a new pick starts at one page again.
  const view = `${service}|${tier}|${source}|${showClosed}|${codes.join(',')}|${needle}`;
  const [paged, setPaged] = useStored(
    'monitor.logs-shown',
    z.object({ view: z.string(), limit: z.number().int().positive() }),
    { view, limit: LOGS_PAGE },
  );

  const inScope = listed.filter(
    (alert) =>
      (service === null || alert.service.name === service) &&
      (source === 'all' || alert.connector === source) &&
      inMonitor(alert, codes) &&
      (showClosed || !CLOSED.includes(alert.status)) &&
      (needle === '' || matches(alert, needle)),
  );
  // The filter shows once a second source is connected, down or has Alerts here.
  const present = LOG_SOURCES.filter(
    (one) =>
      sources.includes(one) ||
      down.some((gone) => gone.source === one) ||
      listed.some((alert) => alert.connector === one),
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
      <div className="flex flex-col gap-2.5 border-b border-divider px-3.5 py-3.5">
        <div className="flex items-baseline gap-2">
          <h2 className="m-0 min-w-0 truncate text-[15px] font-extrabold tracking-tight">
            {service ?? 'All Services'}
          </h2>
          <span className="flex-none text-xs text-neutral-700">Failing logs</span>
          <span
            className="ml-auto flex-none font-mono text-xs text-neutral-700"
            title="The range and HTTP status codes the Services column reads"
          >
            {range} · HTTP {codes.length > 0 ? codes.join(', ') : '400+'}
          </span>
        </div>
        <div role="tablist" aria-label="Severity" className="flex gap-0.5 rounded-lg bg-neutral-200 p-0.75">
          {(['all', ...SEVERITIES] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tier === value}
              title={TAB_TIP[value]}
              onClick={() => setTier(value)}
              className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border-0 py-1 text-xs whitespace-nowrap transition-colors ${tier === value ? 'bg-card font-semibold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'}`}
            >
              {value !== 'all' && <span aria-hidden className={`size-1.75 rounded-full ${TIER_BAR[value]}`} />}
              {value === 'all' ? 'All' : SEVERITY_LABEL[value]}
              <span className="font-mono text-[11px] opacity-80">
                {value === 'all' ? inScope.length : counts[value]}
              </span>
            </button>
          ))}
        </div>
        {present.length > 1 && (
          <div role="tablist" aria-label="Source" className="flex flex-wrap gap-0.5 rounded-lg bg-neutral-200 p-0.75">
            {(['all', ...present] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={source === value}
                aria-label={value === 'all' ? 'All sources' : undefined}
                title={
                  value === 'all' ? 'Alerts from every log source' : `Only Alerts read from ${CONNECTOR_NAMES[value]}`
                }
                onClick={() => onSource(value)}
                className={`flex flex-1 cursor-pointer items-center justify-center rounded-md border-0 px-2 py-1 text-xs whitespace-nowrap transition-colors ${source === value ? 'bg-card font-semibold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'}`}
              >
                {value === 'all' ? 'All' : SOURCE_LABEL[value]}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-1.5">
          <div className="relative min-w-0 flex-1">
            <svg
              aria-hidden
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-neutral-600"
            >
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5 14 14" />
            </svg>
            <input
              type="search"
              aria-label="Search logs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Route, message, code, Service"
              title="Keeps the logs whose route, message, status code, Service or status holds these words, in any case"
              className="w-full rounded-lg border border-line bg-card py-1.5 pr-2.5 pl-7.5 text-xs text-text outline-none focus:border-accent-400"
            />
          </div>
          <label
            className="flex flex-none cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-neutral-700 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
            title="Also show resolved and dismissed Alerts"
          >
            <input
              type="checkbox"
              checked={showClosed}
              onChange={() => setShowClosed(!showClosed)}
              className="peer sr-only"
            />
            <span
              aria-hidden
              className="relative h-3.25 w-5.5 rounded-full bg-neutral-300 transition-colors peer-checked:bg-accent after:absolute after:top-0.5 after:left-0.5 after:size-2.25 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-2.25"
            />
            Closed
          </label>
        </div>
      </div>

      {down
        .filter((gone) => source === 'all' || gone.source === source)
        .map((gone) => (
          <p
            key={gone.source}
            role="status"
            className="m-0 border-b border-divider bg-accent-100 px-3.5 py-2 text-xs text-accent-900"
          >
            {SOURCE_LABEL[gone.source]} is down{gone.reason ? `: ${gone.reason.replace(/\.$/, '')}` : ''}. Scans skip it
            until a check passes; its Alerts stay.
          </p>
        ))}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {alerts.isError ? (
          <Empty>Could not read Alerts: {alerts.error.message}</Empty>
        ) : alerts.isPending ? (
          <Empty>Reading Alerts…</Empty>
        ) : shown.length === 0 ? (
          <Empty>
            {needle !== ''
              ? `No logs match “${query.trim()}”.`
              : inScope.length > 0
                ? 'None here.'
                : service
                  ? `No logs from ${service} yet. Scan it for the last ${range}.`
                  : 'No logs yet. Pick a Service or Scan them all.'}
          </Empty>
        ) : (
          <ul aria-label="Logs" className="m-0 flex list-none flex-col gap-0.5 p-2">
            {drawn.map((alert, index) => (
              <Fragment key={alert.id}>
                {tier === 'all' && alert.severity !== drawn[index - 1]?.severity && (
                  <li className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-[0.07em] text-neutral-600 uppercase">
                    <span aria-hidden className={`size-1.75 rounded-full ${TIER_BAR[alert.severity]}`} />
                    {SEVERITY_LABEL[alert.severity]}
                    <span className="ml-auto font-mono tracking-normal normal-case">{counts[alert.severity]}</span>
                  </li>
                )}
                <Row
                  alert={alert}
                  selected={selected === alert.id}
                  showService={service === null}
                  onSelect={() => onSelect(alert.id)}
                />
              </Fragment>
            ))}
            {left === 0 && showClosed && closed.hasNextPage && (
              <li className="px-1.5 pt-1 pb-2">
                <button
                  type="button"
                  disabled={closed.isFetchingNextPage}
                  onClick={() => void closed.fetchNextPage()}
                  className="w-full cursor-pointer rounded-md border border-divider bg-card px-3 py-2 text-xs font-semibold text-text shadow-sm hover:bg-neutral-200 disabled:cursor-default disabled:opacity-60"
                >
                  {closed.isFetchingNextPage ? 'Reading…' : 'Load older resolved and dismissed'}
                </button>
              </li>
            )}
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
