import {
  type AlertListItem,
  CONNECTOR_NAMES,
  LOG_SOURCES,
  type LogSource,
  SEVERITIES,
  type Severity,
} from '@ops-console/shared';
import { BrandIcon, CONNECTOR_BRAND } from '../components/ui/brand-icon';
import { useAlerts, useScans } from '../lib/queries';
import { CLOSED } from './alert-status';
import { SOURCE_LABEL, type SourceFilter } from './log-source';
import { ago, shown as inMonitor } from './scan-scope';
import { sourceState } from './scan-summary';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const TIER_TEXT: Record<Severity, string> = {
  high: 'text-accent font-bold',
  medium: 'text-warn font-bold',
  low: 'text-neutral-700',
};

/** The log sources the tabs name: connected, down, or still holding Alerts. */
export function presentSources(
  sources: LogSource[],
  down: { source: LogSource }[],
  alerts: AlertListItem[],
): LogSource[] {
  return LOG_SOURCES.filter(
    (one) =>
      sources.includes(one) ||
      down.some((gone) => gone.source === one) ||
      alerts.some((alert) => alert.connector === one),
  );
}

function Counts({ alerts }: { alerts: AlertListItem[] }) {
  const tiers = SEVERITIES.map((severity) => ({
    severity,
    count: alerts.filter((alert) => alert.severity === severity).length,
  })).filter((tier) => tier.count > 0);
  if (tiers.length === 0) return <span className="font-mono text-xs text-neutral-600">No open Alerts</span>;
  return (
    <span className="flex items-baseline gap-2 font-mono text-xs tabular-nums">
      {tiers.map(({ severity, count }) => (
        <span
          key={severity}
          title={`${count} open ${severity} ${count === 1 ? 'Alert' : 'Alerts'}`}
          className={TIER_TEXT[severity]}
        >
          {compact.format(count)}
          <span className="sr-only"> {severity}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * One tab per log source, after "All sources": the source's open Alerts by tier and one line of state, so a source
 * that is down or mid-Scan shows beside the ones that are healthy.
 */
export function SourceTabs({
  sources,
  down,
  source,
  onSource,
  codes,
}: {
  /** The log sources connected now. */
  sources: LogSource[];
  /** The log sources that stopped answering, with the check's reason. */
  down: { source: LogSource; reason: string | null }[];
  source: SourceFilter;
  onSource: (source: SourceFilter) => void;
  codes: number[];
}) {
  const alerts = useAlerts();
  const scans = useScans();
  const open = (alerts.data ?? []).filter((alert) => !CLOSED.includes(alert.status) && inMonitor(alert, codes));
  const present = presentSources(sources, down, alerts.data ?? []);
  if (present.length < 1) return null;
  const okCount = present.filter((one) => !down.some((gone) => gone.source === one)).length;

  const tab = (selected: boolean) =>
    `relative flex min-w-37 max-w-52 flex-1 cursor-pointer flex-col gap-1 rounded-xl border bg-card px-3 py-2.5 text-left shadow-sm transition-colors ${selected ? 'border-text shadow-[0_0_0_1px_var(--color-text)]' : 'border-line hover:border-divider'}`;

  return (
    <div className="relative px-7 max-[1180px]:px-5">
      <div
        role="tablist"
        aria-label="Source"
        className="flex gap-2 overflow-x-auto px-0.5 pt-0.5 pb-3 [scrollbar-width:none]"
      >
        <button
          type="button"
          role="tab"
          aria-selected={source === 'all'}
          aria-label="All sources"
          title="Alerts from every log source"
          onClick={() => onSource('all')}
          className={tab(source === 'all')}
        >
          <span className="flex items-center gap-2 text-[13px] font-semibold">
            <span
              aria-hidden
              className="inline-flex size-6 flex-none items-center justify-center rounded-md bg-text text-bg"
            >
              <svg
                aria-hidden
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m12 3 9 5-9 5-9-5 9-5Z" />
                <path d="m3 13 9 5 9-5" />
                <path d="m3 17.5 9 5 9-5" opacity="0.55" />
              </svg>
            </span>
            All sources
          </span>
          <Counts alerts={open} />
          <span className="text-[11px] text-neutral-600">
            {okCount} of {present.length} ok
          </span>
        </button>
        {present.map((one) => {
          const mine = open.filter((alert) => alert.connector === one);
          const gone = down.find((entry) => entry.source === one);
          const health = sourceState(one, scans.data ?? [], down);
          const scanning = health.kind === 'running';
          const failed = health.kind === 'failed' || health.kind === 'stopped';
          const state = gone
            ? gone.reason?.replace(/\.$/, '') || 'Not answering'
            : scanning
              ? 'Scanning…'
              : failed
                ? health.kind === 'stopped'
                  ? 'Last Scan stopped'
                  : 'Last Scan failed'
                : health.finishedAt
                  ? `Last Scan ${ago(health.finishedAt)}`
                  : 'No Scan yet';
          return (
            <button
              key={one}
              type="button"
              role="tab"
              aria-selected={source === one}
              aria-label={SOURCE_LABEL[one]}
              title={
                gone
                  ? `${CONNECTOR_NAMES[one]} is down. Scans skip it until a check passes; its Alerts stay.`
                  : `Only Alerts read from ${CONNECTOR_NAMES[one]}`
              }
              onClick={() => onSource(one)}
              className={tab(source === one)}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <BrandIcon brand={CONNECTOR_BRAND[one]} size="sm" />
                <span className="min-w-0 truncate">{SOURCE_LABEL[one]}</span>
                {health.kind === 'notes' && (
                  <span
                    aria-hidden
                    title={health.notes.join('\n')}
                    className="ml-auto inline-flex size-4 flex-none items-center justify-center rounded-full bg-warn/15 text-[10px] font-bold text-warn"
                  >
                    !
                  </span>
                )}
                <span
                  aria-hidden
                  className={`${health.kind === 'notes' ? '' : 'ml-auto '}size-2 flex-none rounded-full ${gone || failed ? 'bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_20%,transparent)]' : scanning ? 'animate-pulse bg-info' : 'bg-ok'}`}
                />
              </span>
              <Counts alerts={mine} />
              <span
                className={`truncate text-[11px] ${gone || failed ? 'font-semibold text-accent-700' : 'text-neutral-600'}`}
              >
                {state}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
