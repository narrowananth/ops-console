import { CheckTarget, HealthArea, HealthInterval, type HealthItem, HealthStatus, isFailing } from '@ops-console/shared';
import { type ReactNode, useMemo, useState } from 'react';
import { Button } from '../components/ui/button';
import { Dropdown } from '../components/ui/dropdown';
import { duration, useNow } from '../components/ui/elapsed';
import { useCheckArea, useHealthChecksSetting, useHealthWatch } from '../lib/queries';

const HOUR_MS = 3_600_000;

/** `14:05`, in the machine's own time. */
export const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

/** `42s ago`, `3 min ago`, `2h ago`. */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)}h ago`;
}

/** How long something has been failing: `<1 min`, `14 min`, `1h 05m`. */
export function held(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export const INTERVALS: { value: HealthInterval; label: string }[] = [
  { value: HealthInterval.HalfHour, label: '30 minutes' },
  { value: HealthInterval.Hour, label: '1 hour' },
  { value: HealthInterval.SixHours, label: '6 hours' },
  { value: HealthInterval.TwelveHours, label: '12 hours' },
  { value: HealthInterval.Day, label: '24 hours' },
  { value: HealthInterval.Off, label: 'Off' },
];

const NOUNS = {
  [HealthArea.Connections]: { many: 'connections', one: 'connection' },
  [HealthArea.Integrations]: { many: 'integrations', one: 'integration' },
} as const;

/** The id a row carries, so the banner's Show can scroll to it. An MCP server is known by its name. */
export const rowDomId = (item: Pick<HealthItem, 'target' | 'id' | 'name'>): string =>
  `health-${item.target}-${item.target === CheckTarget.McpServer ? item.name : item.id}`;

/** The area's items and where its run stands; empty while the daemon does not answer. */
export function useAreaHealth(area: HealthArea) {
  const health = useHealthWatch();
  const items = useMemo(() => (health.data?.items ?? []).filter((item) => item.area === area), [health.data, area]);
  return { state: health.data?.areas[area], items, failing: items.filter((item) => isFailing(item.status)) };
}

const card = 'rounded-lg border px-4 py-3 text-xs';

/**
 * The area's auto-check strip: how often it checks, when it last did and will next, how far a run is, and Check now.
 * It shows once the daemon answers `/health-watch`, or when Check now could not run.
 */
export function HealthStrip({ area }: { area: HealthArea }) {
  const { state } = useAreaHealth(area);
  const setting = useHealthChecksSetting();
  const check = useCheckArea(area);
  const now = useNow(state !== undefined);
  if (!state) return null;
  const interval = state.interval;
  const off = interval === HealthInterval.Off;
  const checking = state.checking !== null || check.isPending;
  const last = state.last_checked_at === null ? null : Date.parse(state.last_checked_at);
  const next = state.next_check_at === null ? null : Date.parse(state.next_check_at);
  const meta = state.checking
    ? `Checking… ${state.checking.done} of ${state.checking.total} done`
    : check.isPending
      ? 'Checking…'
      : [
          off ? 'Auto-check off' : null,
          last === null ? (off ? null : 'Not checked yet') : `Last checked ${ago(now - last)}`,
          !off && next !== null ? (next > now ? `next in ${duration(next - now)}` : 'next check due') : null,
        ]
          .filter(Boolean)
          .join(' · ');
  return (
    <div className="border-b border-divider">
      <fieldset
        aria-label="Auto-check"
        className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-0 px-5 py-2.5 text-xs"
      >
        <span
          aria-hidden
          className={`size-2 flex-none rounded-full ${
            checking ? 'animate-pulse bg-warn' : off ? 'bg-neutral-400' : 'bg-ok'
          }`}
        />
        <strong className="text-[13px]">Auto-check</strong>
        <span className="flex items-center gap-1.5 text-neutral-700">
          every
          <Dropdown
            label="Check every"
            compact
            value={setting.current[area]}
            options={INTERVALS}
            onChange={(value) => setting.set(area, value)}
            listClassName="w-40"
            className="w-32"
          />
        </span>
        <span role="status" className="text-neutral-700">
          {meta}
        </span>
        <span className="flex-1" />
        <Button
          className="px-2.5 py-1 text-xs"
          title="Check everything on this page now"
          disabled={checking}
          onClick={() => check.mutate()}
        >
          Check now
        </Button>
      </fieldset>
      {check.isError && (
        <div
          role="alert"
          className={`${card} mx-5 mb-3 flex items-center gap-3 border-accent-300 bg-accent-100 text-accent-700`}
        >
          <span className="flex-1">
            <strong>The check could not run:</strong> {check.error.message}
          </span>
          <Button className="px-2.5 py-1 text-xs" onClick={() => check.mutate()}>
            Try again
          </Button>
        </div>
      )}
      {setting.error && (
        <div role="alert" className="mx-5 mb-3 text-xs text-accent-700">
          Could not save the interval: {setting.error.message}
        </div>
      )}
    </div>
  );
}

/**
 * What needs the operator on this page: a red banner naming the failing items with why and since when, or a green one
 * when everything answers. `action` adds the item's own Sign in or Reconnect beside it.
 */
export function HealthBanner({ area, action }: { area: HealthArea; action?: (item: HealthItem) => ReactNode }) {
  const { state, items, failing } = useAreaHealth(area);
  const noun = NOUNS[area];
  if (failing.length === 0) {
    if (!state || state.last_checked_at === null || !items.some((item) => item.status === HealthStatus.Ok)) return null;
    const answering = items.filter((item) => item.status !== HealthStatus.Off).length;
    return (
      <div className="px-5 pt-3">
        <div role="status" className={`${card} border-ok/30 bg-ok/10 text-ok`}>
          <strong>Everything answers.</strong>{' '}
          <span className="text-neutral-800">
            {answering} {answering === 1 ? noun.one : noun.many} checked.
          </span>
        </div>
      </div>
    );
  }
  return <Problems failing={failing} noun={noun} action={action} />;
}

/** The failing items sharing one reason, for the compact banner. */
type Reason = { detail: string; items: HealthItem[]; since: string | null };

/** Groups by identical detail text, the biggest group first, then the one that began failing earliest. */
function reasonsOf(failing: HealthItem[]): Reason[] {
  const groups = new Map<string, Reason>();
  for (const item of failing) {
    const detail = item.detail?.trim() || 'Not answering';
    const group = groups.get(detail) ?? { detail, items: [], since: null };
    group.items.push(item);
    if (item.failing_since && (group.since === null || item.failing_since < group.since)) {
      group.since = item.failing_since;
    }
    groups.set(detail, group);
  }
  return [...groups.values()].sort(
    (a, b) => b.items.length - a.items.length || (a.since ?? '').localeCompare(b.since ?? ''),
  );
}

const SHOWN_REASONS = 2;
const SHOWN_NAMES = 3;
/** Up to this many failing items the banner lists each one; more start folded into reasons. */
const LISTED = 3;

function Problems({
  failing,
  noun,
  action,
}: {
  failing: HealthItem[];
  noun: (typeof NOUNS)[HealthArea];
  action?: (item: HealthItem) => ReactNode;
}) {
  const [forced, setForced] = useState<boolean | null>(null);
  const long = failing.length > LISTED;
  const expanded = forced ?? !long;
  const first = failing[0];
  const reasons = reasonsOf(failing);
  return (
    <div className="px-5 pt-3">
      <section aria-label="Needs attention" className={`${card} border-accent-300 bg-accent-100 text-accent-900`}>
        <div className="flex items-center gap-3">
          <strong className="flex-1 text-[13px] text-accent-700">
            {failing.length === 1 && first
              ? `${first.name} needs attention`
              : `${failing.length} ${noun.many} need attention`}
          </strong>
          {long && (
            <Button className="px-2.5 py-1 text-xs" aria-expanded={expanded} onClick={() => setForced(!expanded)}>
              {expanded ? 'Show less' : 'Show all'}
            </Button>
          )}
        </div>
        {expanded ? (
          <ul
            aria-label="Failing items"
            className="m-0 mt-2 flex max-h-60 list-none flex-col gap-1.5 overflow-auto p-0"
          >
            {failing.map((item) => (
              <li key={`${item.target}:${item.id}`} className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="font-mono font-semibold">{item.name}</span>
                <span className="min-w-0 flex-[1_1_60%] break-words text-accent-800">
                  {item.detail ?? 'Not answering'}
                </span>
                {item.failing_since && <span className="text-neutral-700">since {clock(item.failing_since)}</span>}
                {action?.(item)}
              </li>
            ))}
          </ul>
        ) : (
          <ul aria-label="Reasons" className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {reasons.slice(0, SHOWN_REASONS).map((reason) => (
              <li key={reason.detail} className="flex min-w-0 items-center gap-2.5">
                <span className="min-w-0 flex-[1_1_40%] truncate font-semibold text-accent-800">{reason.detail}</span>
                <span className="flex flex-none items-center gap-1">
                  {reason.items.slice(0, SHOWN_NAMES).map((item) => (
                    <span
                      key={`${item.target}:${item.id}`}
                      className="rounded-md bg-card/80 px-1.5 py-px font-mono text-[11px] text-text"
                    >
                      {item.name}
                    </span>
                  ))}
                  {reason.items.length > SHOWN_NAMES && (
                    <span className="text-neutral-700">+{reason.items.length - SHOWN_NAMES} more</span>
                  )}
                </span>
                {reason.since && <span className="flex-none text-neutral-700">since {clock(reason.since)}</span>}
              </li>
            ))}
            {reasons.length > SHOWN_REASONS && (
              <li className="text-neutral-700">and {reasons.length - SHOWN_REASONS} more reasons</li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

/** `FAILING 14 min`, counting up while it fails. */
export function FailingPill({ since }: { since: string | null }) {
  const now = useNow(since !== null);
  return (
    <span className="rounded-full bg-accent-100 px-2 py-px font-sans text-xs font-semibold whitespace-nowrap text-accent-700">
      FAILING{since ? ` ${held(now - Date.parse(since))}` : ''}
    </span>
  );
}

/** Whether an item answered again within the hour. */
export const isRecovered = (item: HealthItem): boolean =>
  item.recovered_at !== null && Date.now() - Date.parse(item.recovered_at) < HOUR_MS;

export function RecoveredPill() {
  return (
    <span className="rounded-full bg-ok/12 px-2 py-px font-sans text-xs font-semibold whitespace-nowrap text-ok">
      RECOVERED
    </span>
  );
}

/** `was down 14:05–14:20`, read from the failing stretch the history ends in. */
function wasDown(item: HealthItem): string | null {
  const points = item.history;
  let end = points.length - 1;
  while (end >= 0 && !isFailing(points[end]?.status ?? HealthStatus.Ok)) end--;
  if (end < 0 || item.recovered_at === null) return null;
  let start = end;
  while (start > 0 && isFailing(points[start - 1]?.status ?? HealthStatus.Ok)) start--;
  const from = points[start]?.at;
  return from ? `was down ${clock(from)}–${clock(item.recovered_at)}` : null;
}

const STRIPE: Record<string, { color: string; word: string }> = {
  [HealthStatus.Ok]: { color: 'bg-ok', word: 'ok' },
  [HealthStatus.Fail]: { color: 'bg-accent', word: 'failing' },
  [HealthStatus.Auth]: { color: 'bg-warn', word: 'needs sign-in' },
};

const SLOTS = 24;

/** The last 24 checks, oldest on the left: green ok, red failing, amber needs sign-in. */
export function History({ points }: { points: HealthItem['history'] }) {
  const shown = points.slice(-SLOTS);
  return (
    <span role="img" aria-label={`Last ${shown.length} checks`} className="flex h-4 items-center gap-0.5">
      {Array.from({ length: SLOTS - shown.length }, (_, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: empty slots are all alike
        <i key={`empty-${at}`} className="block h-full w-1 rounded-sm bg-neutral-200" />
      ))}
      {shown.map((point) => {
        const look = STRIPE[point.status] ?? { color: 'bg-neutral-400', word: point.status };
        return (
          <i
            key={point.at}
            title={`${clock(point.at)} · ${look.word}`}
            data-status={point.status}
            className={`block h-full w-1 rounded-sm ${look.color}`}
          />
        );
      })}
    </span>
  );
}

/**
 * Under a row: the history, when it was checked, how fast it answered, and the row's own actions. An item that is off
 * (never answered, or turned off) has nothing to say here: its row keeps its own "not connected" or "off" look.
 */
export function HealthLine({ item, children }: { item: HealthItem; children?: ReactNode }) {
  const now = useNow(item.last_checked_at !== null);
  const down = isRecovered(item) ? wasDown(item) : null;
  if (item.status === HealthStatus.Off) return null;
  if (item.history.length === 0 && item.last_checked_at === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-xs text-neutral-700">
      <History points={item.history} />
      {item.last_checked_at && <span>checked {ago(now - Date.parse(item.last_checked_at))}</span>}
      {item.latency_ms !== null && <span className="font-mono">{item.latency_ms} ms</span>}
      {down && <span className="text-ok">{down}</span>}
      {children}
    </div>
  );
}
