import { CONNECTOR_NAMES, type LogSource, type Scan, ScanStatus } from '@ops-console/shared';
import { SOURCE_LABEL } from './log-source';
import { ago } from './scan-scope';

type Kind = 'ok' | 'notes' | 'failed' | 'stopped' | 'down' | 'running' | 'none';

/** How one log source stands: its newest Scan, or why it cannot be scanned. */
export type SourceState = {
  source: LogSource;
  kind: Kind;
  /** When the newest Scan finished, if it did. */
  finishedAt: string | null;
  notes: string[];
  /** The sentence that explains a source that is not plainly fine. */
  detail: string | null;
};

/** `Datadog`, `Datadog and Loki`, `Datadog, Loki and New Relic`. */
const and = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** The state of one source from the Scans, newest first, and the log sources that are down. */
export function sourceState(
  source: LogSource,
  scans: Scan[],
  down: { source: LogSource; reason: string | null }[],
): SourceState {
  const gone = down.find((entry) => entry.source === source);
  const newest = scans.find((row) => row.connector === source);
  const finishedAt = newest?.finished_at ?? null;
  const base = { source, finishedAt, notes: newest?.notes ?? [] };
  if (gone) {
    const why = gone.reason ? `: ${gone.reason.replace(/\.$/, '')}` : '';
    return {
      ...base,
      kind: 'down',
      detail: `${SOURCE_LABEL[source]} is down${why}. Scans skip it until a check passes; its Alerts stay.`,
    };
  }
  if (!newest) return { ...base, kind: 'none', detail: null };
  if (newest.status === ScanStatus.Running) return { ...base, kind: 'running', detail: null };
  if (newest.status === ScanStatus.Ok) {
    if (!finishedAt) return { ...base, kind: 'none', detail: null };
    return { ...base, kind: newest.notes.length > 0 ? 'notes' : 'ok', detail: null };
  }
  const lastGood = scans.find((row) => row.connector === source && row.status === ScanStatus.Ok)?.finished_at;
  const what =
    newest.status === ScanStatus.RateLimited
      ? `hit a ${CONNECTOR_NAMES[source]} rate limit`
      : newest.status === ScanStatus.Cancelled
        ? 'was stopped'
        : `could not read ${CONNECTOR_NAMES[source]}`;
  return {
    ...base,
    kind: newest.status === ScanStatus.Cancelled ? 'stopped' : 'failed',
    detail: `The last Scan ${what}. ${lastGood ? `Last good one ${ago(lastGood)}.` : 'No good Scan yet.'}`,
  };
}

export type StatusPart = { text: string; tone: 'plain' | 'note' | 'warning' };

/**
 * The one sentence over the Monitor, as parts the header colours: how many sources were scanned and when, then each
 * thing the operator must not miss (a failed or stopped Scan, a source that is down, an overdue Scan), then the notes.
 */
export function statusParts(states: SourceState[], overdue: string[]): StatusPart[] {
  const total = states.length;
  if (total === 0) return [];
  const of = (kind: Kind) => states.filter((state) => state.kind === kind);
  const named = (kind: Kind) => and(of(kind).map((state) => SOURCE_LABEL[state.source]));
  const scanned = states.filter((state) => state.kind === 'ok' || state.kind === 'notes');
  const newest = scanned
    .map((state) => state.finishedAt)
    .filter((at): at is string => at !== null)
    .sort()
    .pop();
  const parts: StatusPart[] = [];
  if (total > 1) {
    const count = scanned.length === total ? `All ${total}` : `${scanned.length} of ${total}`;
    parts.push({ text: `${count} sources scanned`, tone: 'plain' });
  }
  if (newest) parts.push({ text: `${total > 1 ? 'last' : 'Last'} Scan ${ago(newest)}`, tone: 'plain' });
  if (of('running').length > 0) parts.push({ text: `Scanning ${named('running')}`, tone: 'plain' });
  if (scanned.length === 0 && of('running').length === 0 && of('none').length > 0) {
    parts.push({ text: total > 1 ? `No Scan yet for ${named('none')}` : 'No Scan yet', tone: 'plain' });
  }
  if (of('failed').length > 0) parts.push({ text: `Scan failed for ${named('failed')}`, tone: 'warning' });
  if (of('stopped').length > 0) parts.push({ text: `Scan stopped for ${named('stopped')}`, tone: 'warning' });
  if (of('down').length > 0) {
    parts.push({ text: `${named('down')} ${of('down').length > 1 ? 'are' : 'is'} down`, tone: 'warning' });
  }
  if (overdue.length > 0) {
    const names = overdue.length <= 2 ? and(overdue) : `${overdue.length} Services`;
    parts.push({ text: `Scan overdue for ${names}`, tone: 'warning' });
  }
  if (of('notes').length > 0) parts.push({ text: `${named('notes')} left notes`, tone: 'note' });
  return parts;
}
