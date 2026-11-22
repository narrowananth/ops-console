import { LOG_SOURCES, type LogSource, SCAN_RANGES, ScanStatus } from '@ops-console/shared';
import { useEffect, useState } from 'react';
import { StopIcon } from '../agents/stop-run';
import { Button, Spinner } from '../components/ui/button';
import { menu } from '../components/ui/item';
import { useAlerts, useCancelScan, useScans, useStartScan } from '../lib/queries';
import { ascending } from '../lib/sort';
import { CLOSED } from './alert-status';
import { CONNECT_A_SOURCE, SOURCE_LABEL, type SourceFilter } from './log-source';
import type { MonitorData } from './monitor-data';
import type { ScanScope } from './scan-scope';
import { type SourceState, type StatusPart, sourceState, statusParts } from './scan-summary';
import { StatusPicker } from './status-picker';

/**
 * The Monitor's top row: the title with one sentence on how the Scans went, then the range and HTTP status codes to
 * read and the Scan button. Scanning reads the ticked Services, else the picked one, else every listed one.
 */
export function MonitorHeader({
  data,
  source,
  scope,
  selected,
  ticked,
  down,
}: {
  data: MonitorData;
  source: SourceFilter;
  scope: ScanScope;
  selected: string | null;
  ticked: string[];
  /** The log sources that stopped answering, with the check's reason. */
  down: { source: LogSource; reason: string | null }[];
}) {
  const scans = useScans();
  const alerts = useAlerts();
  const scan = useStartScan();
  const cancel = useCancelScan();
  const { inView, names, rows, scanCount, known, codesError } = data;
  const states = LOG_SOURCES.filter(
    (one) => (source === 'all' || one === source) && (inView.includes(one) || down.some((gone) => gone.source === one)),
  ).map((one) => sourceState(one, scans.data ?? [], down));
  // The Services with an open Alert that no Scan has read for 2 Check intervals.
  const overdue = ascending(
    [
      ...new Set(
        (alerts.data ?? [])
          .filter(
            (alert) =>
              alert.scan_overdue && !CLOSED.includes(alert.status) && (source === 'all' || alert.connector === source),
          )
          .map((alert) => alert.service.name),
      ),
    ],
    (name) => name,
  );
  const runningScans = (scans.data ?? []).filter(
    (row) => row.status === ScanStatus.Running && states.some((state) => state.source === row.connector),
  );
  const running = runningScans.length > 0;
  const toScan = ticked.filter((name) => rows.some((row) => row.name === name));
  const scanTip =
    inView.length === 0
      ? CONNECT_A_SOURCE
      : running
        ? 'A Scan is running. Wait for it to finish.'
        : toScan.length === 0 && !selected && scanCount === 0
          ? 'No Services to Scan in this range'
          : `Read the failing requests in ${names} now, group them into Alerts and mark each Route healthy, failing or rapid. The schedule also scans on its own.`;

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2.5 px-7 pt-5 pb-3.5 max-[1180px]:px-5">
      <div className="flex min-w-0 flex-1 basis-80 items-baseline gap-x-3.5">
        <h2 className="m-0 flex-none text-[22px] font-bold tracking-tight">Monitor</h2>
        <StatusLine
          states={states}
          overdue={overdue}
          error={scan.isError || cancel.isError ? (scan.error ?? cancel.error)?.message : undefined}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <fieldset
          aria-label="Range"
          title={`How far back the list, the counts and the next Scan read in ${names}`}
          className="m-0 flex min-w-0 gap-0.5 rounded-full border-0 bg-neutral-200 p-0.75"
        >
          {SCAN_RANGES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope.range === value}
              title={`Read the last ${value} of logs from ${names}`}
              onClick={() => scope.pickRange(value)}
              className={`cursor-pointer rounded-full border-0 px-3 py-1 font-mono text-xs transition-colors ${scope.range === value ? 'bg-card font-semibold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'}`}
            >
              {value}
            </button>
          ))}
        </fieldset>
        {known ? (
          <StatusPicker known={known} scope={scope} from={names} />
        ) : (
          <span className="text-xs text-neutral-700">
            {inView.length === 0
              ? 'No log source is connected.'
              : codesError
                ? `Could not read status codes: ${codesError.message}`
                : 'Reading status codes…'}
          </span>
        )}
        <Button
          variant="primary"
          className="py-2 text-[13px]"
          disabled={
            inView.length === 0 || scan.isPending || running || (toScan.length === 0 && !selected && scanCount === 0)
          }
          title={scanTip}
          onClick={() =>
            scan.mutate({
              service_id: null,
              window: scope.range,
              // Left out, the Scan reads every connected source.
              ...(source !== 'all' ? { connector: source } : {}),
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
        {running && (
          <Button
            title="Stop the Scan now. What it read so far is dropped."
            className="py-2 text-[13px]"
            disabled={cancel.isPending}
            onClick={() => {
              for (const row of runningScans) cancel.mutate(row.id);
            }}
          >
            {cancel.isPending ? <Spinner /> : <StopIcon />}
            Stop
          </Button>
        )}
      </div>
    </header>
  );
}

const TONE: Record<StatusPart['tone'], string> = {
  plain: 'text-neutral-700',
  note: 'text-warn',
  warning: 'font-semibold text-accent-700',
};

/**
 * One line on how the Scans went: how many sources were scanned and when, with what to act on in colour. A source
 * with something to say opens its detail in a box under the line.
 */
function StatusLine({
  states,
  overdue,
  error,
}: {
  states: SourceState[];
  overdue: string[];
  error: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const parts = statusParts(states, overdue);
  const flagged = states.filter((state) => state.detail !== null || state.notes.length > 0);
  const hasDetail = flagged.length > 0 || overdue.length > 0;
  const line = parts.map((part, index) => (
    <span key={part.text} className={TONE[part.tone]}>
      {index > 0 && <span className="text-neutral-500"> · </span>}
      {part.text}
    </span>
  ));
  return (
    <div className="relative flex min-w-0 items-baseline gap-2 text-xs">
      {open && (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="fixed inset-0 z-50 cursor-default"
          onClick={() => setOpen(false)}
        />
      )}
      <span role="status" className="min-w-0 truncate">
        {hasDetail ? (
          <button
            type="button"
            aria-haspopup="true"
            aria-expanded={open}
            aria-label={parts.map((part) => part.text).join(' · ')}
            title="Which sources need a look, and why"
            onClick={() => setOpen(!open)}
            className="max-w-full cursor-pointer truncate border-0 bg-transparent p-0 text-left text-xs underline decoration-dotted decoration-neutral-500 underline-offset-4"
          >
            {line}
            <span aria-hidden className="text-neutral-600">
              {' '}
              ▾
            </span>
          </button>
        ) : (
          line
        )}
      </span>
      {error && (
        <span role="alert" title={error} className="min-w-0 truncate text-accent-700">
          {error}
        </span>
      )}
      {open && (
        <section aria-label="Scan details" className={`absolute top-full left-0 z-51 mt-1.5 w-lg max-w-[80vw] ${menu}`}>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-1.5">
            {flagged.map((state) => (
              <li key={state.source} className="flex flex-col gap-1">
                <span className="text-[13px] font-semibold">{SOURCE_LABEL[state.source]}</span>
                {state.detail && <span className="text-accent-700">{state.detail}</span>}
                {state.notes.length > 0 && (
                  <ul
                    aria-label={`${SOURCE_LABEL[state.source]} notes`}
                    className="m-0 flex list-none flex-col gap-0.5 p-0 text-warn"
                  >
                    {state.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
            {overdue.length > 0 && (
              <li className="flex flex-col gap-1">
                <span className="text-[13px] font-semibold">Overdue</span>
                <span className="text-accent-700">
                  No Scan has read {overdue.join(', ')} for 2 Check intervals. A failure there may be gone.
                </span>
              </li>
            )}
          </ul>
        </section>
      )}
    </div>
  );
}
