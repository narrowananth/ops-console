import {
  AlertStatus,
  FIX_STAGES,
  FixStatus,
  type Report,
  ReportKind,
  ReviewDecision,
  RunStatus,
  type Sample,
} from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import {
  useAlert,
  useAlertEvents,
  useAlertReports,
  useConnectors,
  useRetryFix,
  useReviewAlert,
  useUndoDismissal,
  useVerifyAlert,
} from '../lib/queries';

function SampleList({ samples }: { samples: Sample[] }) {
  const [asJson, setAsJson] = useState(false);
  return (
    <section aria-label="Samples">
      <div className="flex items-center gap-2 py-1.5">
        <strong className="text-[13px]">Samples ({samples.length})</strong>
        <button
          type="button"
          aria-pressed={asJson}
          onClick={() => setAsJson((on) => !on)}
          className="ml-auto cursor-pointer border border-divider bg-transparent px-2 py-0.5 text-[11px] text-text"
        >
          {asJson ? 'Messages' : 'JSON'}
        </button>
      </div>
      {asJson ? (
        <pre className="m-0 max-h-80 overflow-auto bg-neutral-900 p-3 font-mono text-xs text-neutral-100">
          {JSON.stringify(samples, null, 2)}
        </pre>
      ) : (
        <ul className="m-0 flex max-h-80 list-none flex-col gap-1 overflow-auto p-0 font-mono text-xs">
          {samples.map((sample) => (
            <li key={sample.id}>
              <span className="text-neutral-700">{new Date(sample.timestamp).toLocaleTimeString()}</span>{' '}
              <span className="font-bold">{sample.status}</span> {sample.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReportPanel({ alertId, report }: { alertId: string; report: Report }) {
  const reports = useAlertReports(alertId);
  const [picked, setPicked] = useState<string | null>(null);
  const versions = reports.data ?? [report];
  const shown = versions.find((row) => row.id === picked) ?? report;
  return (
    <section aria-label="Report" className="border-2 border-text">
      <header className="flex items-center gap-2 border-b border-divider bg-surface px-3 py-2 text-xs">
        <strong>Report v{shown.version}</strong>
        {versions.length > 1 && (
          <select
            aria-label="Report version"
            value={shown.id}
            onChange={(event) => setPicked(event.target.value)}
            className="border border-divider bg-bg px-1 text-xs text-text"
          >
            {versions.map((row) => (
              <option key={row.id} value={row.id}>
                v{row.version} · {row.status}
              </option>
            ))}
          </select>
        )}
        <span className="ml-auto text-neutral-700">{shown.status}</span>
      </header>
      <div className="flex flex-col gap-3 px-3 py-2.5 text-[13px]">
        {shown.steps.length > 0 && (
          <ol className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-xs">
            {shown.steps.map((step, index) => (
              // Steps are an append-only list: the index is their identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
              <li key={index} className={step.kind === 'error' ? 'text-accent-700' : ''}>
                {step.text}
              </li>
            ))}
          </ol>
        )}
        {shown.status === RunStatus.Running && <p className="m-0">The agent is verifying…</p>}
        {shown.status === RunStatus.Failed && (
          <p role="alert" className="m-0 text-accent-700">
            The Verification did not finish{shown.error_message ? ` (${shown.error_message})` : ''}. Verify again.
          </p>
        )}
        {shown.root_cause && (
          <div>
            <div className="text-[10px] tracking-[0.08em] text-neutral-700 uppercase">Root cause</div>
            <p className="m-0">{shown.root_cause}</p>
          </div>
        )}
        {shown.proposed_fix && (
          <div>
            <div className="text-[10px] tracking-[0.08em] text-neutral-700 uppercase">Proposed fix</div>
            <p className="m-0">{shown.proposed_fix}</p>
          </div>
        )}
        {shown.diff && (
          <pre className="m-0 overflow-auto bg-neutral-900 p-3 font-mono text-xs text-neutral-100">
            {shown.diff.map((line) => `${line.sign}${line.text}`).join('\n')}
          </pre>
        )}
        {shown.replay && (
          <div>
            <div className="text-[10px] tracking-[0.08em] text-neutral-700 uppercase">Replay</div>
            <pre className="m-0 overflow-auto font-mono text-xs">{shown.replay.request}</pre>
            <pre className="m-0 overflow-auto font-mono text-xs text-neutral-700">{shown.replay.response}</pre>
          </div>
        )}
      </div>
    </section>
  );
}

export function AlertView({ id }: { id: string }) {
  const alert = useAlert(id);
  const events = useAlertEvents(id);
  const connectors = useConnectors();
  const verify = useVerifyAlert(id);
  const review = useReviewAlert(id);
  const undo = useUndoDismissal(id);
  const retry = useRetryFix(alert.data?.fix?.id ?? '');
  if (alert.isPending) return <Empty>Reading the Alert…</Empty>;
  if (alert.isError) return <Empty>Could not read the Alert: {alert.error.message}</Empty>;
  const data = alert.data;
  const jira = connectors.data?.data.find((connector) => connector.id === 'jira');
  const jiraUp = jira?.status === 'ok';
  const report = data.latest_report;
  const canVerify = data.status === AlertStatus.Open || data.status === AlertStatus.Verified;
  const error = verify.error ?? review.error ?? undo.error ?? retry.error;

  return (
    <article className="flex flex-col gap-4 px-6 py-5">
      <header>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="border border-text px-1.5 py-px font-bold">{data.severity.toUpperCase()}</span>
          <span className="text-neutral-700">{data.status}</span>
          {data.regression_count > 0 && (
            <span className="border border-accent px-1.5 py-px text-accent-700">
              regression ×{data.regression_count}
            </span>
          )}
          {data.waiting_since && (
            <span className="text-neutral-700">waiting since {new Date(data.waiting_since).toLocaleString()}</span>
          )}
        </div>
        <h1 className="m-0 mt-1 text-lg">{data.title}</h1>
        <div className="font-mono text-xs text-neutral-700">
          {data.event_count} events · first {new Date(data.first_seen_at).toLocaleString()} · last{' '}
          {new Date(data.last_seen_at).toLocaleString()}
        </div>
        <div className="mt-1 font-mono text-xs break-all">{data.log_line}</div>
        <div className="mt-1 font-mono text-[11px] break-all text-neutral-700">{data.datadog_query}</div>
      </header>

      {error && (
        <div role="alert" className="text-[13px] text-accent-700">
          {error.message}
        </div>
      )}

      {canVerify && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={verify.isPending} onClick={() => verify.mutate()}>
            {data.status === AlertStatus.Verified ? 'Verify again' : 'Verify with agent'}
          </Button>
          <span className="text-xs text-neutral-700">
            Maps the log to the local code and replays the request against the Repo running locally.
          </span>
        </div>
      )}

      {report && <ReportPanel alertId={id} report={report} />}

      {data.status === AlertStatus.Verified && report?.kind && (
        <section aria-label="Review" className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            disabled={!jiraUp || review.isPending}
            onClick={() => review.mutate({ decision: ReviewDecision.Confirmed, kind: ReportKind.Bug })}
          >
            Confirm · create Jira bug
          </Button>
          <Button
            disabled={!jiraUp || review.isPending}
            onClick={() => review.mutate({ decision: ReviewDecision.Confirmed, kind: ReportKind.Improvement })}
          >
            Confirm · create Jira improvement
          </Button>
          <Button
            variant="ghost"
            disabled={review.isPending}
            onClick={() => review.mutate({ decision: ReviewDecision.Dismissed, kind: null })}
          >
            Dismiss
          </Button>
          {!jiraUp && (
            <span className="text-xs text-accent-700">Connect Jira in Settings › Connectors to confirm.</span>
          )}
        </section>
      )}

      {data.status === AlertStatus.Dismissed && (
        <div className="border border-dashed border-neutral-400 px-3 py-2.5 text-[13px] text-neutral-700">
          Dismissed. The Route stays on the Report and is checked again at the next Scan.{' '}
          <Button
            variant="ghost"
            className="px-2 py-0.5 text-xs"
            disabled={undo.isPending}
            onClick={() => undo.mutate()}
          >
            Undo
          </Button>
        </div>
      )}

      {data.fix && (
        <section aria-label="Fix" className="border-2 border-text px-3 py-2.5">
          <ol className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs">
            {FIX_STAGES.map((stage) => {
              const at = FIX_STAGES.indexOf(data.fix?.stage ?? stage);
              const index = FIX_STAGES.indexOf(stage);
              const done = data.fix?.status === FixStatus.Done || index < at;
              const failed = data.fix?.status === FixStatus.Failed && index === at;
              return (
                <li
                  key={stage}
                  className={
                    failed ? 'font-bold text-accent-700' : done ? '' : index === at ? 'font-bold' : 'text-neutral-700'
                  }
                >
                  {done ? '✓' : failed ? '✕' : index === at ? '◐' : '·'} {stage}
                </li>
              );
            })}
          </ol>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            {data.fix.jira_key && (
              <a href={data.fix.jira_url ?? undefined} target="_blank" rel="noreferrer">
                {data.fix.jira_key}
              </a>
            )}
            {data.fix.pr_url && (
              <a href={data.fix.pr_url} target="_blank" rel="noreferrer">
                PR #{data.fix.pr_number}
              </a>
            )}
            {data.fix.status === FixStatus.Failed && (
              <>
                <span role="alert" className="text-accent-700">
                  {data.fix.error_message}
                </span>
                <Button className="px-2.5 py-1 text-xs" disabled={retry.isPending} onClick={() => retry.mutate()}>
                  Retry from {data.fix.stage}
                </Button>
              </>
            )}
          </div>
        </section>
      )}

      <SampleList samples={data.samples} />

      <section aria-label="Events">
        <strong className="text-[13px]">Events</strong>
        <ol className="m-0 mt-1 list-none p-0 font-mono text-xs">
          {(events.data ?? []).map((event) => (
            <li key={event.id}>
              <span className="text-neutral-700">{new Date(event.at).toLocaleString()}</span>{' '}
              {event.kind.replace('_', ' ')} <span className="text-neutral-700">· {event.actor}</span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
