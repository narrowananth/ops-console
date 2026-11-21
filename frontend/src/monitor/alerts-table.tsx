import {
  type AlertListItem,
  AlertStatus,
  type LogSource,
  type ScanWindow,
  SEVERITIES,
  Severity,
} from '@ops-console/shared';
import { z } from 'zod';
import { BrandIcon, CONNECTOR_BRAND } from '../components/ui/brand-icon';
import { Empty } from '../components/ui/empty';
import { useAlerts, useClosedAlerts } from '../lib/queries';
import { useStored } from '../lib/remember';
import { CLOSED, STATUS_TIP } from './alert-status';
import { SOURCE_LABEL, type SourceFilter } from './log-source';
import { FreshnessNote, MergeNote } from './prod-notes';
import { ago, shown as inMonitor } from './scan-scope';
import { SEVERITY_LABEL } from './severity';
import { StatusBadge } from './status-picker';

export { STATUS_TIP };

type Tier = 'attention' | 'all' | Severity;
const TIERS = ['attention', 'all', ...SEVERITIES] as const;

const TAB_TIP: Record<Tier, string> = {
  attention: 'High and Medium Alerts: the ones that need a look. Low ones stay behind a row at the end.',
  all: 'Every Alert in view, highest tier first',
  high: 'Only High Alerts: errors reached the rapid threshold in one 10-minute stretch',
  medium: 'Only Medium Alerts: errors per hour reached the failing threshold',
  low: 'Only Low Alerts: failing below the Medium and High thresholds',
};
const TAB_LABEL: Record<Tier, string> = {
  attention: 'Needs attention',
  all: 'All',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

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

const TIER_DOT: Record<Severity, string> = { high: 'bg-accent', medium: 'bg-warn', low: 'bg-neutral-400' };
const TIER_TEXT: Record<Severity, string> = { high: 'text-accent', medium: 'text-warn', low: 'text-neutral-600' };

/** The error counts of a Route's last Scans as small bars; the newest is solid. */
function Trend({ counts, severity }: { counts: number[] | undefined; severity: Severity }) {
  if (!counts || counts.length < 2) return <span className="text-neutral-500">·</span>;
  const last = counts.slice(-14);
  const top = Math.max(1, ...last);
  return (
    <svg
      role="img"
      aria-label={`Errors in the last ${last.length} Scans`}
      width={last.length * 5.5}
      height="22"
      viewBox={`0 0 ${last.length * 5.5} 22`}
      className={TIER_TEXT[severity]}
    >
      <title>{`Errors in the last ${last.length} Scans: ${last.join(', ')}`}</title>
      {last.map((count, index) => {
        const h = Math.max(2, (count / top) * 20);
        return (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: the bars have no id and never reorder
            key={index}
            x={index * 5.5}
            y={22 - h}
            width="3.6"
            height={h}
            rx="1"
            fill="currentColor"
            opacity={index === last.length - 1 ? 1 : 0.45}
          />
        );
      })}
    </svg>
  );
}

function Row({
  alert,
  selected,
  trend,
  onSelect,
}: {
  alert: AlertListItem;
  selected: boolean;
  trend: number[] | undefined;
  onSelect: () => void;
}) {
  const route = alert.route;
  return (
    <tr
      aria-selected={selected}
      onClick={onSelect}
      className={`cursor-pointer transition-colors ${selected ? 'bg-accent-100' : 'hover:bg-neutral-200/50'}`}
    >
      <td className={`w-1 p-0 ${selected ? 'shadow-[inset_3px_0_0_var(--color-accent)]' : ''}`} />
      <td className="border-b border-line py-3 pr-3 pl-2 whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.04em] uppercase">
          <span aria-hidden className={`size-2 rounded-full ${TIER_DOT[alert.severity]}`} />
          {SEVERITY_LABEL[alert.severity]}
        </span>
      </td>
      <td className="max-w-0 min-w-60 border-b border-line py-3 pr-3">
        <button
          type="button"
          aria-current={selected}
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          className="block w-full min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="flex w-full items-baseline gap-2">
            {route ? (
              <>
                <span className="flex-none rounded bg-neutral-200 px-1.5 font-mono text-[10px] font-bold text-neutral-700">
                  {route.method}
                </span>
                <span
                  className="min-w-0 truncate font-mono text-[13px] font-semibold"
                  title={`The Route that failed: ${route.method} ${route.path}`}
                >
                  {route.path}
                </span>
              </>
            ) : (
              <span className="min-w-0 truncate text-[13px] font-semibold">{alert.title}</span>
            )}
            {alert.status !== AlertStatus.Open && (
              <span
                title={STATUS_TIP[alert.status]}
                className="flex-none rounded-full bg-neutral-200 px-1.75 font-mono text-[11px] font-normal text-neutral-700"
              >
                {alert.status.replace('_', ' ')}
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11.5px] text-neutral-600">
            {alert.log_line || alert.title}
          </span>
        </button>
        <span className="mt-1 flex items-center gap-2 text-xs empty:hidden">
          <FreshnessNote alert={alert} warningOnly />
          <MergeNote alert={alert} />
        </span>
      </td>
      <td className="border-b border-line py-3 pr-3 text-[13px] whitespace-nowrap max-[1180px]:hidden">
        {alert.service.name}
      </td>
      <td className="border-b border-line py-3 pr-3">
        {alert.http_status !== null && <StatusBadge code={alert.http_status} />}
      </td>
      <td className="border-b border-line py-3 pr-3">
        <span title={`Read from ${SOURCE_LABEL[alert.connector]}`} className="inline-flex">
          <BrandIcon brand={CONNECTOR_BRAND[alert.connector]} size="xs" />
          <span className="sr-only">{SOURCE_LABEL[alert.connector]}</span>
        </span>
      </td>
      <td
        className="border-b border-line py-3 pr-4 text-right font-mono text-[12.5px] font-semibold tabular-nums"
        title={`Seen ${alert.event_count} ${alert.event_count === 1 ? 'time' : 'times'}`}
      >
        ×{alert.event_count}
      </td>
      <td className="border-b border-line py-3 pr-4 max-[1180px]:hidden">
        <Trend counts={trend} severity={alert.severity} />
      </td>
      <td
        className="border-b border-line py-3 pr-4 text-xs whitespace-nowrap text-neutral-700"
        title={`Last seen ${new Date(alert.last_seen_at).toLocaleString()}`}
      >
        {ago(alert.last_seen_at)}
      </td>
    </tr>
  );
}

const TH =
  'sticky top-0 z-1 border-b border-line bg-card py-2.5 pr-3 text-left text-[10.5px] font-semibold tracking-[0.07em] text-neutral-600 uppercase whitespace-nowrap';
const PAGE_BUTTON =
  'cursor-pointer rounded-md border border-divider bg-card px-3 py-2 text-xs font-semibold text-text shadow-sm hover:bg-neutral-200 disabled:cursor-default disabled:opacity-60';

/** The Monitor's list: the Alerts a Scan raised for the source and Service in view, one row each, highest tier first. */
export function AlertsTable({
  service,
  codes,
  range,
  selected,
  onSelect,
  down,
  source,
  trends,
  servicesMenu,
}: {
  service: string | null;
  codes: number[];
  range: ScanWindow;
  selected: string | null;
  onSelect: (alertId: string) => void;
  /** The log sources that stopped answering, with the check's reason. */
  down: { source: LogSource; reason: string | null }[];
  source: SourceFilter;
  /** The error counts of each Route's last Scans, by Route id. */
  trends: Map<string, number[]>;
  /** The Services button, which sits in the toolbar. */
  servicesMenu: React.ReactNode;
}) {
  const alerts = useAlerts();
  const [tier, setTier] = useStored<Tier>('monitor.tier', z.enum(TIERS), 'attention');
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
  const counts = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, inScope.filter((alert) => alert.severity === severity).length]),
  ) as Record<Severity, number>;
  const countOf = (value: Tier) =>
    value === 'all' ? inScope.length : value === 'attention' ? counts.high + counts.medium : counts[value];
  const keep = (alert: AlertListItem) =>
    tier === 'all' || (tier === 'attention' ? alert.severity !== 'low' : alert.severity === tier);
  // Highest tier first; within a tier the API's order, newest sighting first.
  const shown = inScope
    .filter(keep)
    .map((alert, index) => ({ alert, index }))
    .sort((a, b) => SEVERITIES.indexOf(a.alert.severity) - SEVERITIES.indexOf(b.alert.severity) || a.index - b.index)
    .map(({ alert }) => alert);
  const picked = selected === null ? -1 : shown.findIndex((alert) => alert.id === selected);
  // The open Alert stays drawn even when it sits past the pages shown.
  const limit = Math.max(paged.view === view ? paged.limit : LOGS_PAGE, picked + 1);
  const drawn = shown.slice(0, limit);
  const left = shown.length - drawn.length;
  const hiddenLow = tier === 'attention' ? counts.low : 0;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5 px-7 pb-3 max-[1180px]:px-5">
        <div role="tablist" aria-label="Severity" className="flex gap-0.5 rounded-full bg-neutral-200 p-0.75">
          {TIERS.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tier === value}
              title={TAB_TIP[value]}
              onClick={() => setTier(value)}
              className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-full border-0 px-3 py-1 text-xs whitespace-nowrap transition-colors ${tier === value ? 'bg-card font-semibold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'}`}
            >
              {TAB_LABEL[value]}
              <span
                className={`font-mono text-[11px] ${value === 'high' && countOf(value) > 0 ? 'font-bold text-accent' : 'opacity-70'}`}
              >
                {countOf(value)}
              </span>
            </button>
          ))}
        </div>
        <div className="relative w-56 min-w-0 max-[1180px]:w-40">
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
        {servicesMenu}
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
        <span
          className="ml-auto font-mono text-xs text-neutral-700"
          title="The range and HTTP status codes the Monitor reads"
        >
          {shown.length} {shown.length === 1 ? 'log' : 'logs'} · {range} · HTTP{' '}
          {codes.length > 0 ? codes.join(', ') : '400+'}
        </span>
      </div>

      {down
        .filter((gone) => source === 'all' || gone.source === source)
        .map((gone) => (
          <p
            key={gone.source}
            role="status"
            className="mx-7 mt-0 mb-3 rounded-lg border border-accent-200 bg-accent-100 px-3.5 py-2 text-xs text-accent-900 max-[1180px]:mx-5"
          >
            {SOURCE_LABEL[gone.source]} is down{gone.reason ? `: ${gone.reason.replace(/\.$/, '')}` : ''}. Scans skip it
            until a check passes; its Alerts stay.
          </p>
        ))}

      <div className="mx-7 mb-5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-sm max-[1180px]:mx-5 max-[1180px]:mb-4">
        <div className="min-h-0 flex-1 overflow-auto">
          {alerts.isError ? (
            <Empty>Could not read Alerts: {alerts.error.message}</Empty>
          ) : alerts.isPending ? (
            <Empty>Reading Alerts…</Empty>
          ) : shown.length === 0 && hiddenLow === 0 ? (
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
            <table aria-label="Logs" className="w-full border-separate border-spacing-0 text-left">
              <thead>
                <tr>
                  <th className={`${TH} w-1 p-0`} />
                  <th className={`${TH} pl-2`}>Severity</th>
                  <th className={TH}>Route</th>
                  <th className={`${TH} max-[1180px]:hidden`}>Service</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Source</th>
                  <th className={`${TH} pr-4 text-right`}>Events</th>
                  <th className={`${TH} max-[1180px]:hidden`} title="Errors in the Route's last Scans">
                    Trend
                  </th>
                  <th className={TH}>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {drawn.map((alert) => (
                  <Row
                    key={alert.id}
                    alert={alert}
                    selected={selected === alert.id}
                    trend={alert.route ? trends.get(alert.route.id) : undefined}
                    onSelect={() => onSelect(alert.id)}
                  />
                ))}
                {hiddenLow > 0 && left === 0 && (
                  <tr>
                    <td colSpan={9} className="bg-bg px-4 py-3.5 text-center text-xs text-neutral-700">
                      <button
                        type="button"
                        onClick={() => setTier(Severity.Low)}
                        className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-text hover:underline"
                      >
                        Show {hiddenLow} Low {hiddenLow === 1 ? 'alert' : 'alerts'}
                      </button>{' '}
                      · failing below the Medium threshold
                    </td>
                  </tr>
                )}
                {left === 0 && showClosed && closed.hasNextPage && (
                  <tr>
                    <td colSpan={9} className="px-4 py-3 text-center">
                      <button
                        type="button"
                        disabled={closed.isFetchingNextPage}
                        onClick={() => void closed.fetchNextPage()}
                        className={PAGE_BUTTON}
                      >
                        {closed.isFetchingNextPage ? 'Reading…' : 'Load older resolved and dismissed'}
                      </button>
                    </td>
                  </tr>
                )}
                {left > 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-3 text-center">
                      <button
                        type="button"
                        onClick={() => setPaged({ view, limit: limit + LOGS_PAGE })}
                        className={PAGE_BUTTON}
                      >
                        Show {Math.min(LOGS_PAGE, left)} more{' '}
                        <span className="font-mono font-normal text-neutral-700">
                          · {drawn.length} of {shown.length}
                        </span>
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
