import {
  AlertStatus,
  FIX_STAGES,
  type Fix,
  FixStage,
  FixStatus,
  PlaybookStepStatus,
  PlaybookTrigger,
  type Report,
  ReportKind,
  ReviewDecision,
  RunStatus,
  type Sample,
} from '@ops-console/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { StopRun } from '../agents/stop-run';
import { Button, Spinner } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DiffLines } from '../components/ui/diff';
import { Dropdown } from '../components/ui/dropdown';
import { Empty } from '../components/ui/empty';
import { Markdown } from '../components/ui/markdown';
import { Pathway, PathwayProgress, type PathwayState, type PathwayStep, StatusPill } from '../components/ui/pathway';
import {
  useAlert,
  useAlertEvents,
  useAlertReports,
  useCancelFix,
  useConnectors,
  usePatchRoute,
  useRetryFix,
  useRetryReport,
  useReviewAlert,
  useUndoDismissal,
  useVerifyAlert,
} from '../lib/queries';
import { useStored } from '../lib/remember';
import {
  failedStep,
  JobPath,
  JobSteps,
  PlaybookLink,
  runState,
  ScratchTag,
  SkipStep,
  stepTally,
  useTriggerPlaybook,
} from '../playbooks/job-steps';
import { withPlaybook } from '../playbooks/labels';
import { CodeSource } from './repo-link';
import { SeverityBadge } from './severity';

function SampleList({ samples }: { samples: Sample[] }) {
  const [asJson, setAsJson] = useStored('monitor.samples-json', z.boolean(), false);
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

function ReportPanel({
  alertId,
  report,
  sessionId,
}: {
  alertId: string;
  report: Report;
  /** The Alert's Session, where the Verification runs. */
  sessionId: string | null;
}) {
  const reports = useAlertReports(alertId);
  const [picked, setPicked] = useStored(`monitor.report.${alertId}`, z.string().nullable(), null);
  const versions = reports.data ?? [report];
  const shown = versions.find((row) => row.id === picked) ?? report;
  return (
    <section aria-label="Report" className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
      <header className="flex items-center gap-2 border-b border-divider bg-surface px-4 py-2 text-xs">
        <strong>Report v{shown.version}</strong>
        {shown.kind && <span className="rounded-full bg-neutral-200 px-2 py-px">{shown.kind}</span>}
        {versions.length > 1 && (
          <Dropdown
            label="Report version"
            caption=""
            value={shown.id}
            options={versions.map((row) => ({ value: row.id, label: `v${row.version} · ${row.status}` }))}
            onChange={setPicked}
            variant="chip"
            opens="down"
            align="left"
            listClassName="w-48"
          />
        )}
        <span className="ml-auto flex items-center gap-2">
          {shown.status === RunStatus.Running && sessionId && (
            <StopRun sessionId={sessionId} title="Stop the Verification; it fails and can retry from its step" />
          )}
          <StatusPill state={runState(shown.status)}>{shown.status}</StatusPill>
        </span>
      </header>
      <div className="flex flex-col gap-3 px-4 py-3 text-[13px]">
        {shown.status !== RunStatus.Ready && (
          <>
            {shown.status === RunStatus.Failed && (
              <p role="alert" className="m-0 text-accent-700">
                The Verification did not finish{shown.error_message ? ` (${shown.error_message})` : ''}. Verify again.
              </p>
            )}
            <VerificationPath report={shown} />
            <Steps report={shown} />
          </>
        )}
        {shown.status === RunStatus.Ready && (
          <>
            {shown.playbook && (
              <details>
                <summary className="cursor-pointer text-xs text-neutral-700">
                  Playbook: {shown.playbook.name}
                  {shown.playbook.steps.length > 0 && ` · ${stepTally(shown.playbook)}`}
                </summary>
                <div className="mt-2">
                  <JobSteps playbook={shown.playbook} />
                </div>
              </details>
            )}
            {shown.markdown ? (
              <Markdown source={shown.markdown} />
            ) : (
              <Markdown
                source={`## Root cause\n\n${shown.root_cause ?? ''}\n\n## Proposed fix\n\n${shown.proposed_fix ?? ''}`}
              />
            )}
            {shown.diff && (
              <details>
                <summary className="cursor-pointer text-xs text-neutral-700">Proposed diff</summary>
                <div className="mt-1.5 overflow-hidden rounded-lg border border-divider bg-card">
                  <DiffLines lines={shown.diff} />
                </div>
              </details>
            )}
            {shown.replay && (
              <details>
                <summary className="cursor-pointer text-xs text-neutral-700">Replay</summary>
                <pre className="m-0 mt-1.5 overflow-auto font-mono text-xs">{shown.replay.request}</pre>
                <pre className="m-0 overflow-auto font-mono text-xs text-neutral-700">{shown.replay.response}</pre>
              </details>
            )}
            {shown.steps.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs text-neutral-700">
                  Agent steps ({shown.steps.length})
                </summary>
                <div className="mt-1.5">
                  <Steps report={shown} />
                </div>
              </details>
            )}
            {shown.markdown_path && (
              <div className="font-mono text-[11px] break-all text-neutral-700">Saved to {shown.markdown_path}</div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** The Verification as a path: the Playbook it copied, its steps live, then the console's closing turn. */
function VerificationPath({ report }: { report: Report }) {
  return (
    <>
      {report.playbook && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-neutral-700">Playbook</span>
          <PlaybookLink playbook={report.playbook} />
        </div>
      )}
      <JobPath
        playbook={report.playbook}
        status={report.status}
        reading={{ todo: 'Read the code', doing: 'Reading the code' }}
        closing={{ todo: 'Write the Report', doing: 'Writing the Report' }}
      />
    </>
  );
}

function Steps({ report }: { report: Report }) {
  if (report.steps.length === 0) return null;
  return (
    <ol className="m-0 flex max-h-72 list-none flex-col gap-0.5 overflow-auto p-0 font-mono text-xs">
      {report.steps.map((step, index) => (
        // Steps are an append-only list: the index is their identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
        <li key={index} className={step.kind === 'error' ? 'text-accent-700' : ''}>
          {step.text}
        </li>
      ))}
    </ol>
  );
}

const STAGE_LABEL: Record<FixStage, string> = {
  [FixStage.Ticket]: 'Ticket',
  [FixStage.Branch]: 'Branch',
  [FixStage.Steps]: 'Steps',
  [FixStage.Pr]: 'PR',
};

const STEP_STATE: Record<PlaybookStepStatus, PathwayState> = {
  [PlaybookStepStatus.Done]: 'done',
  [PlaybookStepStatus.Skipped]: 'skipped',
  [PlaybookStepStatus.Failed]: 'failed',
  [PlaybookStepStatus.Running]: 'running',
  [PlaybookStepStatus.Pending]: 'pending',
};

const FIX_STATE: Record<FixStatus, PathwayState> = {
  [FixStatus.Running]: 'running',
  [FixStatus.Done]: 'done',
  [FixStatus.Failed]: 'failed',
  [FixStatus.Abandoned]: 'pending',
};

const outLink = 'font-semibold text-text';

/**
 * The Fix as a path: Ticket, Branch, each step of its Playbook by title, and PR, each with what it made. The ticket
 * shows as skipped, with why, when Jira was not connected or the ticket was not made. A failed stage carries the error
 * and Retry.
 */
function FixProgress({ fix, onRetry, retrying }: { fix: Fix; onRetry: (skip: boolean) => void; retrying: boolean }) {
  const cancel = useCancelFix(fix.id);
  const [asking, setAsking] = useState(false);
  const cancellable = (fix.status === FixStatus.Running || fix.status === FixStatus.Failed) && fix.pr_number === null;
  const at = FIX_STAGES.indexOf(fix.stage);
  const stageState = (index: number): PathwayState =>
    fix.status === FixStatus.Done || index < at
      ? 'done'
      : index === at
        ? fix.status === FixStatus.Failed
          ? 'failed'
          : fix.status === FixStatus.Abandoned
            ? 'pending'
            : 'running'
        : 'pending';
  const failed = failedStep(fix.playbook);
  const retry = fix.status === FixStatus.Failed && (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-accent-200 bg-accent-100/60 px-3 py-2">
      {fix.error_message && (
        <span role="alert" className="text-accent-900">
          {fix.error_message}
        </span>
      )}
      <div className="flex flex-wrap gap-2">
        <Button className="px-2.5 py-1 text-xs" disabled={retrying} onClick={() => onRetry(false)}>
          {retrying && <Spinner />}
          {fix.stage === FixStage.Steps && failed !== null
            ? `Retry from step ${failed}`
            : `Retry from ${STAGE_LABEL[fix.stage]}`}
        </Button>
        {fix.stage === FixStage.Steps && failed !== null && (
          <SkipStep step={failed} disabled={retrying} onSkip={() => onRetry(true)} />
        )}
      </div>
    </div>
  );

  const steps: PathwayStep[] = FIX_STAGES.flatMap((stage, index): PathwayStep[] => {
    const state = stageState(index);
    const failedHere = state === 'failed' && retry;
    if (stage === FixStage.Steps && fix.playbook && fix.playbook.steps.length > 0) {
      return fix.playbook.steps.map((step, position) => {
        const stepState = STEP_STATE[step.status];
        return {
          key: `step-${position}`,
          title: step.title,
          state: stepState,
          aside: step.writes ? <ScratchTag /> : undefined,
          // A failed step's error already says what its summary says.
          children: stepState === 'failed' && retry ? retry : step.summary && <span>{step.summary}</span>,
        };
      });
    }
    if (stage === FixStage.Ticket) {
      const noJira = state === 'done' && fix.jira_key === null;
      return [
        {
          key: stage,
          title: 'Ticket',
          state: noJira ? 'skipped' : state,
          children: (fix.jira_key || noJira || failedHere) && (
            <>
              {fix.jira_key && (
                <a href={fix.jira_url ?? undefined} target="_blank" rel="noreferrer" className={outLink}>
                  {fix.jira_key} →
                </a>
              )}
              {noJira && (
                <span>
                  {fix.ticket_skipped
                    ? `No ticket: ${fix.ticket_skipped}. The Fix went on without one.`
                    : 'No Jira connected.'}
                </span>
              )}
              {failedHere}
            </>
          ),
        },
      ];
    }
    if (stage === FixStage.Branch) {
      return [
        {
          key: stage,
          title: 'Branch',
          state,
          children: (fix.branch || failedHere) && (
            <>
              {fix.branch && (
                <span className="self-start rounded-full bg-neutral-200 px-2 py-0.5 font-mono text-text">
                  {fix.branch}
                </span>
              )}
              {failedHere}
            </>
          ),
        },
      ];
    }
    return [
      {
        key: stage,
        title: stage === FixStage.Pr ? 'Pull request' : STAGE_LABEL[stage],
        state,
        children: (fix.pr_url || failedHere || (state === 'running' && stage === FixStage.Pr)) && (
          <>
            {state === 'running' && !fix.pr_url && <span>Committing, pushing and opening the PR…</span>}
            {fix.pr_url && (
              <a href={fix.pr_url} target="_blank" rel="noreferrer" className={outLink}>
                PR #{fix.pr_number} →
              </a>
            )}
            {failedHere}
          </>
        ),
      },
    ];
  });

  return (
    <section
      aria-label="Fix"
      className="flex flex-col gap-3.5 rounded-xl border border-line bg-card px-5 py-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <strong className="font-heading text-sm">Fix</strong>
        <StatusPill state={FIX_STATE[fix.status]}>{fix.status}</StatusPill>
        {fix.playbook && <PlaybookLink playbook={fix.playbook} label={`Playbook: ${fix.playbook.name}`} />}
        <span className="ml-auto flex items-center gap-3">
          {fix.session_id && (
            <Link to={`/workspace?session=${fix.session_id}`} className="text-xs">
              Open the Session →
            </Link>
          )}
          {fix.session_id && fix.status === FixStatus.Running && (
            <StopRun sessionId={fix.session_id} title="Stop the Fix; it fails and can retry from where it stopped" />
          )}
          {cancellable && (
            <Button
              className="px-2.5 py-1 text-xs"
              title="Stop the Fix, undo its branch and go back to the Review"
              onClick={() => {
                cancel.reset();
                setAsking(true);
              }}
            >
              Cancel Fix
            </Button>
          )}
        </span>
      </div>
      {asking && (
        <ConfirmDialog
          title="Cancel this Fix?"
          action="Cancel the Fix"
          dismiss="Keep it"
          pending={cancel.isPending}
          error={cancel.error?.message ?? null}
          onCancel={() => setAsking(false)}
          onConfirm={() => cancel.mutate(undefined, { onSuccess: () => setAsking(false) })}
        >
          <p className="m-0">
            The agent stops. Its uncommitted changes go on the git stash
            {fix.branch ? (
              <>
                , branch <code>{fix.branch}</code> is deleted
              </>
            ) : null}
            , and the Repo goes back to the source branch. The Alert returns to the Review, so you can start a new Fix
            or dismiss it.
            {fix.jira_key ? ` Jira ${fix.jira_key} stays as it is.` : ''}
          </p>
        </ConfirmDialog>
      )}
      <PathwayProgress steps={steps} />
      <Pathway label="Fix progress" steps={steps} />
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
  const retryReport = useRetryReport();
  const patchRoute = usePatchRoute();
  const verifyPlaybook = useTriggerPlaybook(PlaybookTrigger.Verify);
  const fixPlaybook = useTriggerPlaybook(PlaybookTrigger.Fix);
  if (alert.isPending) return <Empty>Reading the Alert…</Empty>;
  if (alert.isError) return <Empty>Could not read the Alert: {alert.error.message}</Empty>;
  const data = alert.data;
  const jira = connectors.data?.data.find((connector) => connector.id === 'jira');
  const jiraUp = jira?.status === 'ok';
  const report = data.latest_report;
  const verifying = data.status === AlertStatus.Verifying;
  // Shown greyed while the agent verifies, so a second click cannot start another run.
  const canVerify = data.status === AlertStatus.Open || data.status === AlertStatus.Verified || verifying;
  const hasCode = data.service.repo_id !== null || data.service.repo_url !== null;
  const error = verify.error ?? review.error ?? undo.error ?? retry.error ?? retryReport.error ?? patchRoute.error;
  // Only the newest Report can run again from its failed step.
  const retryFrom = report?.status === RunStatus.Failed ? failedStep(report.playbook) : null;
  const kind = report?.kind ?? ReportKind.Bug;
  const other = kind === ReportKind.Bug ? ReportKind.Improvement : ReportKind.Bug;

  return (
    <article className="flex flex-col gap-4 px-6 py-5">
      <header>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <SeverityBadge severity={data.severity} />
          <span className="text-neutral-700">{data.status.replace('_', ' ')}</span>
          {data.regression_count > 0 && (
            <span className="rounded-full bg-accent-100 px-2 py-px text-accent-700">
              regression ×{data.regression_count}
            </span>
          )}
          {data.waiting_since && (
            <span className="text-neutral-700">waiting since {new Date(data.waiting_since).toLocaleString()}</span>
          )}
        </div>
        <h1 className="m-0 mt-1 text-lg break-words">{data.title}</h1>
        <div className="flex flex-wrap items-center gap-x-2 font-mono text-xs text-neutral-700">
          <span className="font-bold text-text">{data.service.name}</span>
          <span>{data.service.env}</span>
          <span>·</span>
          <span>{data.route ? `${data.route.method} ${data.route.path}` : 'no HTTP route'}</span>
          {data.route && (
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[11px] text-accent hover:underline"
              disabled={patchRoute.isPending}
              onClick={() => data.route && patchRoute.mutate({ id: data.route.id, ignored: true })}
            >
              Ignore this Route
            </button>
          )}
        </div>
        <div className="font-mono text-xs text-neutral-700">
          {data.event_count} events · first {new Date(data.first_seen_at).toLocaleString()} · last{' '}
          {new Date(data.last_seen_at).toLocaleString()}
        </div>
        <pre className="m-0 mt-2 rounded-lg bg-neutral-900 p-3 font-mono text-xs whitespace-pre-wrap break-all text-neutral-100">
          {data.log_line}
        </pre>
        <div className="mt-1 font-mono text-[11px] break-all text-neutral-700">{data.datadog_query}</div>
      </header>

      {error && (
        <div role="alert" className="text-[13px] text-accent-700">
          {error.message}
        </div>
      )}

      <CodeSource key={`${data.service.id}:${data.service.repo_url ?? ''}`} service={data.service} />

      {canVerify && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={verify.isPending || verifying || !hasCode}
            onClick={() => verify.mutate()}
          >
            {(verify.isPending || verifying) && <Spinner />}
            {verifying
              ? 'Agent verifying…'
              : verify.isPending
                ? 'Starting the agent…'
                : withPlaybook(
                    data.status === AlertStatus.Verified ? 'Verify again' : 'Verify with agent',
                    verifyPlaybook,
                  )}
          </Button>
          {report && retryFrom !== null && !verifying && (
            <>
              <Button
                disabled={retryReport.isPending || verify.isPending}
                onClick={() => retryReport.mutate({ id: report.id })}
              >
                {retryReport.isPending && <Spinner />}
                Retry from step {retryFrom}
              </Button>
              <SkipStep
                step={retryFrom}
                disabled={retryReport.isPending || verify.isPending}
                onSkip={() => retryReport.mutate({ id: report.id, skip: true })}
              />
            </>
          )}
          <span className="text-xs text-neutral-700">
            {hasCode
              ? 'The agent traces the log through the code end to end and writes a Report: the issue and how to fix it.'
              : 'Give the code first: a local Repo or a Git URL.'}
          </span>
        </div>
      )}

      {report && <ReportPanel alertId={id} report={report} sessionId={data.session_id} />}

      {data.status === AlertStatus.Verified && report?.kind && (
        <section aria-label="Review" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={review.isPending}
              onClick={() => review.mutate({ decision: ReviewDecision.Confirmed, kind })}
            >
              {review.isPending && <Spinner />}
              {withPlaybook('Fix with agent', fixPlaybook)}
            </Button>
            <Button
              disabled={review.isPending}
              onClick={() => review.mutate({ decision: ReviewDecision.Confirmed, kind: other })}
            >
              {withPlaybook(`Fix as ${other}`, fixPlaybook)}
            </Button>
            <Button
              variant="ghost"
              disabled={review.isPending}
              onClick={() => review.mutate({ decision: ReviewDecision.Dismissed, kind: null })}
            >
              Dismiss
            </Button>
          </div>
          <span className="text-xs text-neutral-700">
            {data.service.repo_id ? 'In a Session on the local Repo' : 'In an anonymous Session with a clone'}:{' '}
            {jiraUp ? 'a Jira ticket, then ' : ''}a branch, the code change, tests, a push and a pull request.
            {jiraUp ? '' : ' Jira is not connected, so the branch is fix/<name>.'}
          </span>
        </section>
      )}

      {data.status === AlertStatus.Dismissed && (
        <div className="rounded-lg border border-dashed border-neutral-400 px-3.5 py-3 text-[13px] text-neutral-700">
          Dismissed. The log stays on the Report and is checked again at the next Scan.{' '}
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

      {data.fix && <FixProgress fix={data.fix} retrying={retry.isPending} onRetry={(skip) => retry.mutate(skip)} />}

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
