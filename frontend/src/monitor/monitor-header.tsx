import { CONNECTOR_NAMES, LOG_SOURCES, SCAN_RANGES, type Scan, ScanStatus } from '@ops-console/shared';
import { StopIcon } from '../agents/stop-run';
import { Button, Spinner } from '../components/ui/button';
import { useCancelScan, useScans, useStartScan } from '../lib/queries';
import { CONNECT_A_SOURCE, SOURCE_LABEL, type SourceFilter } from './log-source';
import type { MonitorData } from './monitor-data';
import { ago, type ScanScope } from './scan-scope';
import { StatusPicker } from './status-picker';

/**
 * The Monitor's top row: the range and HTTP status codes to read, and the Scan button with how the newest Scan of
 * each source in view went. Scanning reads the ticked Services, else the picked one, else every listed one.
 */
export function MonitorHeader({
  data,
  source,
  scope,
  selected,
  ticked,
}: {
  data: MonitorData;
  source: SourceFilter;
  scope: ScanScope;
  selected: string | null;
  ticked: string[];
}) {
  const scans = useScans();
  const scan = useStartScan();
  const cancel = useCancelScan();
  const { inView, names, rows, scanCount, known, codesError } = data;
  // The newest Scan of each source in view.
  const latest = LOG_SOURCES.filter((one) => source === 'all' || one === source).flatMap((one) => {
    const newest = scans.data?.find((row) => row.connector === one);
    return newest ? [newest] : [];
  });
  const runningScans = latest.filter((row) => row.status === ScanStatus.Running);
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
    <header className="flex flex-wrap items-start gap-x-4 gap-y-3 px-7 pt-5 pb-3.5 max-[1180px]:px-5">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h2 className="m-0 text-[22px] font-bold tracking-tight">Monitor</h2>
        {latest.map((row) => (
          <ScanStatusLine
            key={row.id}
            scan={row}
            named={latest.length > 1}
            lastGood={scans.data?.find((one) => one.connector === row.connector && one.status === ScanStatus.Ok)}
          />
        ))}
        {(scan.isError || cancel.isError) && (
          <span role="alert" className="text-xs text-accent-700">
            {(scan.error ?? cancel.error)?.message}
          </span>
        )}
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

/** How the newest Scan of one source went: when it finished and its notes, or why it did not. */
function ScanStatusLine({ scan, named, lastGood }: { scan: Scan; named: boolean; lastGood: Scan | undefined }) {
  const label = named ? `${SOURCE_LABEL[scan.connector]} · ` : '';
  const failed =
    scan.status === ScanStatus.Failed || scan.status === ScanStatus.RateLimited || scan.status === ScanStatus.Cancelled;
  if (failed) {
    return (
      <span role="status" className="text-xs text-accent-700">
        The last {named ? `${SOURCE_LABEL[scan.connector]} ` : ''}Scan{' '}
        {scan.status === ScanStatus.RateLimited
          ? `hit a ${CONNECTOR_NAMES[scan.connector]} rate limit`
          : scan.status === ScanStatus.Cancelled
            ? 'was stopped'
            : `could not read ${CONNECTOR_NAMES[scan.connector]}`}
        . {lastGood?.finished_at ? `Last good one ${ago(lastGood.finished_at)}.` : 'No good Scan yet.'}
      </span>
    );
  }
  if (!scan.finished_at) return null;
  return (
    <div className="flex flex-col gap-1 text-xs text-neutral-700">
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <span aria-hidden className="size-1.75 flex-none rounded-full bg-ok" />
        <span>
          {label}Last Scan {ago(scan.finished_at)}
        </span>
      </div>
      {scan.notes.length > 0 && (
        <ul aria-label="Scan notes" className="m-0 flex list-none flex-col gap-0.5 p-0 text-accent-700">
          {scan.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
