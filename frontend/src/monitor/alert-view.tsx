import {
  AlertStatus,
  CONNECTOR_NAMES,
  FIX_STAGES,
  type Fix,
  FixStage,
  FixStatus,
  type LogSource,
  PlaybookStepStatus,
  PlaybookTrigger,
  type Report,
  ReportKind,
  ReviewDecision,
  RunStatus,
  type Sample,
} from '@ops-console/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { REPORT_KIND_TIP } from '../agents/report-document';
import { StopRun } from '../agents/stop-run';
import { Button, Spinner } from '../components/ui/button';
import { CodeBlock } from '../components/ui/code-block';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DiffLines } from '../components/ui/diff';
import { Dropdown } from '../components/ui/dropdown';
import { Elapsed } from '../components/ui/elapsed';
import { Empty } from '../components/ui/empty';
import { FoldTitle, useFold } from '../components/ui/fold';
import { Markdown } from '../components/ui/markdown';
import { Pathway, PathwayProgress, type PathwayState, type PathwayStep, StatusPill } from '../components/ui/pathway';
import { Hint } from '../components/ui/tip';
import {
  useAlert,
  useAlertEvents,
  useAlertReports,
  useCancelFix,
  useConnectors,
  useRetryFix,
  useRetryReport,
  useReviewAlert,
  useSkipRunningStep,
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
  SkillsOffered,
  SkipStep,
  stepTally,
  useTriggerPlaybook,
} from '../playbooks/job-steps';
import { withPlaybook } from '../playbooks/labels';
import { sessionPath } from '../workspace/links';
import { PrTabs } from '../workspace/pr-tabs';
import { STATUS_TIP } from './alert-status';
import { QUERY_TIP, readableQuery, SourceLabel } from './log-source';
import { FreshnessNote, MergeNote, ReportNotes } from './prod-notes';
import { CodeSource } from './repo-link';
import { ago } from './scan-scope';
import { SeverityBadge } from './severity';
import { StatusBadge } from './status-picker';

const REPORT_STATUS_TIP: Record<RunStatus, string> = {
  [RunStatus.Running]: 'The agent is verifying the Alert. Each Playbook step runs as its own turn.',
  [RunStatus.Ready]: 'The Report is written. Review it below: Fix it, or dismiss it.',
  [RunStatus.Failed]: 'The Verification stopped before the Report was written. Retry it or verify again.',
};

const FIX_STATUS_TIP: Record<FixStatus, string> = {
  [FixStatus.Running]: 'The agent is working through the Fix stages.',
  [FixStatus.Done]: 'The PR is open. Merging it resolves the Alert.',
  [FixStatus.Failed]: 'A stage failed. Retry from it, or cancel the Fix.',
  [FixStatus.Abandoned]: 'The Fix was cancelled, or its PR was closed unmerged. The Alert is back at its Review.',
};

/** One Sample as JSON in a dialog. Escape, Close and a click on the dimmed page close it. */
function SampleDialog({ sample, onClose }: { sample: Sample; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const box = dialog.current;
    if (!box || box.open) return;
    box.showModal();
    return () => box.close();
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a modal dialog natively; the click is the backdrop
    <dialog
      ref={dialog}
      aria-label="Sample"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => event.target === event.currentTarget && onClose()}
      className="m-auto w-[min(720px,calc(100vw-32px))] rounded-xl border border-line bg-card p-0 text-text shadow-2xl backdrop:bg-neutral-900/35"
    >
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <strong className="text-[13px]">Sample</strong>
        <span className="font-mono text-xs text-neutral-700">{new Date(sample.timestamp).toLocaleString()}</span>
        <Button className="ml-auto px-3 py-1 text-xs" onClick={onClose}>
          Close
        </Button>
      </div>
      <CodeBlock
        text={JSON.stringify(sample, null, 2)}
        wrapperClassName="p-4"
        className="m-0 max-h-[70vh] overflow-auto rounded-lg bg-neutral-900 p-3 font-mono text-xs whitespace-pre-wrap break-all text-neutral-100"
      />
    </dialog>
  );
}

function SampleList({ samples, source }: { samples: Sample[]; source: LogSource }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Sample | null>(null);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? samples.filter((sample) =>
        needle.split(/\s+/).every((word) => `${sample.status}\n${sample.message}`.toLowerCase().includes(word)),
      )
    : samples;
  return (
    <section aria-label="Samples" className="flex flex-col gap-2">
      <div className="flex items-center gap-2 py-0.5">
        <strong className="text-[13px]">
          Samples ({needle ? `${shown.length} of ${samples.length}` : samples.length})
        </strong>
        <Hint
          text={`${CONNECTOR_NAMES[source]} log events kept on this Alert. Secret values and request body values are redacted. Click one to see it as JSON.`}
        />
      </div>
      <div className="relative">
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
          aria-label="Search Samples"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search level, message, request id"
          className="w-full rounded-lg border border-line bg-card py-1.5 pr-2.5 pl-7.5 text-xs text-text outline-none focus:border-accent-400"
        />
      </div>
      {shown.length === 0 ? (
        <p className="m-0 py-3 text-center text-xs text-neutral-700">No Samples match “{query.trim()}”.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
          <table className="w-full border-collapse text-left font-mono text-xs">
            <thead>
              <tr className="font-sans text-[10.5px] tracking-[0.07em] text-neutral-600 uppercase">
                <th className="px-3.5 pt-2.5 pb-1.5 font-semibold">Time</th>
                <th className="px-2 pt-2.5 pb-1.5 font-semibold">Level</th>
                <th className="px-2 pt-2.5 pr-3.5 pb-1.5 font-semibold">Message</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((sample) => (
                <tr key={sample.id} className="align-top transition-colors hover:bg-neutral-200/50">
                  <td className="border-t border-line px-3.5 py-2 whitespace-nowrap text-neutral-700">
                    {new Date(sample.timestamp).toLocaleTimeString()}
                  </td>
                  <td className="border-t border-line px-2 py-2 font-semibold text-warn">{sample.status}</td>
                  <td className="border-t border-line p-0">
                    <button
                      type="button"
                      title="Show this Sample as JSON"
                      onClick={() => setOpen(sample)}
                      className="block w-full cursor-pointer border-0 bg-transparent py-2 pr-3.5 pl-2 text-left font-mono text-xs break-all text-text"
                    >
                      {sample.message}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <SampleDialog sample={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function ReportPanel({
  alertId,
  report,
  sessionId,
  picked,
  setPicked,
}: {
  alertId: string;
  /** The version the operator picked; the newest when none. */
  picked: string | null;
  setPicked: (id: string) => void;
  report: Report;
  /** The Alert's Session, where the Verification runs. */
  sessionId: string | null;
}) {
  const reports = useAlertReports(alertId);
  const versions = reports.data ?? [report];
  const shown = versions.find((row) => row.id === picked) ?? report;
  const [folded, toggle] = useFold('report');
  return (
    <section aria-label="Report" className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
      <header
        className={`flex items-center gap-2 bg-surface px-4 py-2 text-xs ${folded ? '' : 'border-b border-divider'}`}
      >
        <FoldTitle label="Report" folded={folded} onToggle={toggle}>
          <strong>Report v{shown.version}</strong>
        </FoldTitle>
        {shown.kind && (
          <span title={REPORT_KIND_TIP[shown.kind]} className="rounded-full bg-neutral-200 px-2 py-px">
            {shown.kind}
          </span>
        )}
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
          {sessionId && (
            <Link
              to={sessionPath(sessionId)}
              className="text-xs"
              title="Open the Alert's Session to read every agent turn"
            >
              Open the Session →
            </Link>
          )}
          {shown.status === RunStatus.Running && sessionId && (
            <StopRun sessionId={sessionId} title="Stop the Verification; it fails and can retry from its step" />
          )}
          <Elapsed from={shown.started_at} to={shown.finished_at} running={shown.status === RunStatus.Running} took />
          <span title={REPORT_STATUS_TIP[shown.status]}>
            <StatusPill state={runState(shown.status)}>{shown.status}</StatusPill>
          </span>
        </span>
      </header>
      <div hidden={folded} className="flex flex-col gap-3 px-4 py-3 text-[13px]">
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
            <ReportNotes steps={shown.steps} />
            {shown.markdown ? (
              <Markdown source={shown.markdown} />
            ) : (
              <Markdown
                source={`## Root cause\n\n${shown.root_cause ?? ''}\n\n## Proposed fix\n\n${shown.proposed_fix ?? ''}`}
              />
            )}
            {shown.diff && (
              <details>
                <summary
                  className="cursor-pointer text-xs text-neutral-700"
                  title="The code change the agent proposes. Nothing is changed until you start a Fix."
                >
                  Proposed diff
                </summary>
                <div className="mt-1.5 overflow-hidden rounded-lg border border-divider bg-card">
                  <DiffLines lines={shown.diff} />
                </div>
              </details>
            )}
            {shown.replay && (
              <details>
                <summary
                  className="cursor-pointer text-xs text-neutral-700"
                  title="The request the agent replayed locally against its scratch copy, and the answer it got"
                >
                  Replay
                </summary>
                <CodeBlock
                  text={shown.replay.request}
                  wrapperClassName="mt-1.5"
                  className="m-0 overflow-auto font-mono text-xs text-text"
                  tone="light"
                />
                <CodeBlock
                  text={shown.replay.response}
                  className="m-0 overflow-auto font-mono text-xs text-neutral-700"
                  tone="light"
                />
              </details>
            )}
            {shown.steps.length > 0 && (
              <details>
                <summary
                  className="cursor-pointer text-xs text-neutral-700"
                  title="Each tool call and message from the Verification, in order"
                >
                  Agent steps ({shown.steps.length})
                </summary>
                <div className="mt-1.5">
                  <Steps report={shown} />
                </div>
              </details>
            )}
            {shown.markdown_path && (
              <div className="font-mono text-xs break-all text-neutral-700">Saved to {shown.markdown_path}</div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** The Verification as a path: the Playbook it copied, its steps live, then the console's closing turn. */
function VerificationPath({ report }: { report: Report }) {
  const skipStep = useSkipRunningStep('report', report.id);
  return (
    <>
      {report.playbook && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-neutral-700">Playbook</span>
          <PlaybookLink
            playbook={report.playbook}
            title="The Playbook this Verification follows. Its rules and steps were copied when it started."
          />
          <SkillsOffered playbook={report.playbook} />
        </div>
      )}
      <JobPath
        playbook={report.playbook}
        status={report.status}
        reading={{ todo: 'Read the code', doing: 'Reading the code' }}
        closing={{ todo: 'Write the Report', doing: 'Writing the Report' }}
        skip={{ isPending: skipStep.isPending, error: skipStep.error, mutate: () => skipStep.mutate() }}
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
        <li key={index} className={step.kind === 'error' || step.kind === 'warning' ? 'text-accent-700' : ''}>
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
  const skipStep = useSkipRunningStep('fix', fix.id);
  const cancel = useCancelFix(fix.id);
  const [asking, setAsking] = useState(false);
  const [fixFolded, toggleFix] = useFold('fix');
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
        <Button
          className="px-2.5 py-1 text-xs"
          title="Run the failed stage again and carry on from there. Work already done is kept."
          disabled={retrying}
          onClick={() => onRetry(false)}
        >
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
          children:
            stepState === 'failed' && retry ? (
              retry
            ) : stepState === 'running' && fix.status === FixStatus.Running ? (
              <span className="flex flex-col items-start gap-1.5">
                {step.summary && <span>{step.summary}</span>}
                <SkipStep
                  step={position + 1}
                  running
                  pending={skipStep.isPending}
                  disabled={skipStep.isPending}
                  onSkip={() => skipStep.mutate()}
                />
                {skipStep.error && (
                  <span role="alert" className="text-xs text-accent-700">
                    {skipStep.error.message}
                  </span>
                )}
              </span>
            ) : (
              step.summary && <span>{step.summary}</span>
            ),
        };
      });
    }
    if (stage === FixStage.Ticket) {
      const noJira = state === 'done' && fix.jira_key === null;
      return [
        {
          key: stage,
          title: 'Ticket',
          aside: (
            <Hint text="The Jira issue for this Fix. Made only when Jira is connected and the Fix Playbook's Jira ticket switch is on. Its key starts the branch name." />
          ),
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
                <span
                  title="The branch the agent made for this Fix. It is pushed with the commit."
                  className="self-start rounded-full bg-neutral-200 px-2 py-0.5 font-mono text-text"
                >
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
        <FoldTitle label="Fix" folded={fixFolded} onToggle={toggleFix}>
          <strong className="font-heading text-sm">Fix</strong>
        </FoldTitle>
        <span title={FIX_STATUS_TIP[fix.status]}>
          <StatusPill state={FIX_STATE[fix.status]}>{fix.status}</StatusPill>
        </span>
        <Elapsed from={fix.started_at} to={fix.finished_at} running={fix.status === FixStatus.Running} took />
        {fix.playbook && (
          <PlaybookLink
            playbook={fix.playbook}
            label={`Playbook: ${fix.playbook.name}`}
            title="The Playbook this Fix follows. Its rules and steps were copied when it started."
          />
        )}
        {fix.playbook && <SkillsOffered playbook={fix.playbook} />}
        <span className="ml-auto flex items-center gap-3">
          {fix.session_id && (
            <Link
              to={sessionPath(fix.session_id)}
              className="text-xs"
              title="Open the Alert's Session to read every agent turn"
            >
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
      {!fixFolded && (
        <>
          <PathwayProgress steps={steps} />
          <Pathway label="Fix progress" steps={steps} />
        </>
      )}
    </section>
  );
}

type DrawerTab = 'overview' | 'samples' | 'query' | 'history';

const FLOW = ['Link code', 'Verify', 'Review', 'Fix & PR'] as const;

/** Where the Alert stands on the way to a pull request: the step that is current, and the ones behind it. */
function currentStep(status: AlertStatus, hasCode: boolean): number {
  if (!hasCode) return 0;
  if (status === AlertStatus.Open || status === AlertStatus.Verifying) return 1;
  if (status === AlertStatus.Verified) return 2;
  if (status === AlertStatus.Fixing || status === AlertStatus.PrOpen) return 3;
  return 4;
}

/** The four steps from a log to a pull request, with the one the operator is on marked. */
function NextSteps({ status, hasCode }: { status: AlertStatus; hasCode: boolean }) {
  const now = currentStep(status, hasCode);
  return (
    <ol aria-label="Steps" className="m-0 flex list-none flex-wrap items-center gap-y-1 p-0 text-xs">
      {FLOW.map((label, index) => (
        <li
          key={label}
          aria-current={index === now ? 'step' : undefined}
          className={`flex items-center gap-1.5 ${index === now ? 'font-bold text-text' : 'text-neutral-600'} ${index > 0 ? 'before:mx-2 before:h-px before:w-4 before:bg-neutral-300' : ''}`}
        >
          <span
            aria-hidden
            className={`flex size-5 items-center justify-center rounded-full border-[1.5px] text-[11px] ${index < now ? 'border-ok bg-ok text-white' : index === now ? 'border-accent bg-accent text-white' : 'border-neutral-400'}`}
          >
            {index < now ? '✓' : index + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

function TabIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}
const OVERVIEW_ICON = <path d="M4 5h16M4 12h16M4 19h10" />;
const SAMPLES_ICON = <path d="M5 4h14v16H5zM9 9h6M9 13h6M9 17h3" />;
const QUERY_ICON = <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12" />;
const HISTORY_ICON = <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 8v4l3 2" />;

export function AlertView({ id, onClose }: { id: string; onClose: () => void }) {
  const alert = useAlert(id);
  const events = useAlertEvents(id);
  const connectors = useConnectors();
  const verify = useVerifyAlert(id);
  const review = useReviewAlert(id);
  const undo = useUndoDismissal(id);
  const retry = useRetryFix(alert.data?.fix?.id ?? '');
  const retryReport = useRetryReport();
  const verifyPlaybook = useTriggerPlaybook(PlaybookTrigger.Verify);
  const fixPlaybook = useTriggerPlaybook(PlaybookTrigger.Fix);
  const [tab, setTab] = useState<DrawerTab>('overview');
  // The Report version the Report panel shows; Retry and Skip belong to the newest only.
  const versions = useAlertReports(id);
  const [viewed, setViewed] = useStored(`monitor.report.${id}`, z.string().nullable(), null);
  if (alert.isPending) return <Empty>Reading the Alert…</Empty>;
  if (alert.isError) return <Empty>Could not read the Alert: {alert.error.message}</Empty>;
  const data = alert.data;
  const jira = connectors.data?.data.find((connector) => connector.id === 'jira');
  const jiraUp = jira?.status === 'ok';
  const ticket = jiraUp && fixPlaybook?.jira_ticket === true;
  const report = data.latest_report;
  const verifying = data.status === AlertStatus.Verifying;
  // Shown greyed while the agent verifies, so a second click cannot start another run.
  const canVerify = data.status === AlertStatus.Open || data.status === AlertStatus.Verified || verifying;
  const hasCode = data.service.repo_id !== null || data.service.repo_url !== null;
  const error = verify.error ?? review.error ?? undo.error ?? retry.error ?? retryReport.error;
  // Only the newest Report can run again from its failed step.
  const readingOlder =
    report !== null &&
    viewed !== null &&
    viewed !== report.id &&
    (versions.data ?? []).some((row) => row.id === viewed);
  const retryFrom = report?.status === RunStatus.Failed && !readingOlder ? failedStep(report.playbook) : null;
  const kind = report?.kind ?? ReportKind.Bug;
  const fixSteps = `${ticket ? 'a Jira ticket, ' : ''}a branch, the Fix Playbook's steps, a push and a pull request. Nothing merges by itself.`;
  const other = kind === ReportKind.Bug ? ReportKind.Improvement : ReportKind.Bug;
  const reviewing = data.status === AlertStatus.Verified && report?.kind;

  return (
    <article className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-none flex-col gap-1.5 px-5.5 pt-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <SeverityBadge severity={data.severity} />
          <SourceLabel source={data.connector} />
          <span className="text-neutral-700" title={STATUS_TIP[data.status]}>
            {data.status.replace('_', ' ')}
          </span>
          {data.regression_count > 0 && (
            <span
              title={`It failed again after a healthy Scan ${data.regression_count} ${data.regression_count === 1 ? 'time' : 'times'}, and reopened`}
              className="rounded-full bg-accent-100 px-2 py-px text-accent-700"
            >
              regression ×{data.regression_count}
            </span>
          )}
          {data.waiting_since && (
            <span className="text-neutral-700" title="When the Report became ready. It waits for your Review.">
              waiting since {new Date(data.waiting_since).toLocaleString()}
            </span>
          )}
          <FreshnessNote alert={data} />
          <MergeNote alert={data} />
          <button
            type="button"
            aria-label="Close the Alert"
            title="Close (Esc)"
            onClick={onClose}
            className="ml-auto flex size-7.5 cursor-pointer items-center justify-center rounded-lg border border-line bg-card text-neutral-700 hover:text-text"
          >
            <svg
              aria-hidden
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="m3 3 10 10M13 3 3 13" />
            </svg>
          </button>
        </div>
        <h1 className="m-0 text-lg leading-snug break-words">{data.title}</h1>
        <div className="flex flex-wrap items-center gap-x-2 font-mono text-xs text-neutral-700">
          <span className="font-semibold text-text">{data.service.name}</span>
          <span
            title={`The env these ${CONNECTOR_NAMES[data.connector]} logs came from. no env means the logs name none.`}
          >
            {data.service.env}
          </span>
          <span>·</span>
          <span>{data.route ? `${data.route.method} ${data.route.path}` : 'no HTTP route'}</span>
        </div>
        <div className="mt-2 pb-3">
          <PrTabs
            label="Alert"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'overview', label: 'Overview', icon: <TabIcon>{OVERVIEW_ICON}</TabIcon> },
              { id: 'samples', label: 'Samples', icon: <TabIcon>{SAMPLES_ICON}</TabIcon>, count: data.samples.length },
              { id: 'query', label: 'Query', icon: <TabIcon>{QUERY_ICON}</TabIcon> },
              { id: 'history', label: 'History', icon: <TabIcon>{HISTORY_ICON}</TabIcon>, count: events.data?.length },
            ]}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5.5 py-4 *:shrink-0">
        {error && (
          <div role="alert" className="text-[13px] text-accent-700">
            {error.message}
          </div>
        )}

        {tab === 'overview' && (
          <>
            <NextSteps status={data.status} hasCode={hasCode} />
            <CodeSource
              key={`${data.service.id}:${data.service.repo_url ?? ''}`}
              service={data.service}
              source={data.connector}
            />
            <dl className="m-0 grid grid-cols-4 overflow-hidden rounded-xl border border-line bg-card text-xs shadow-sm max-[1180px]:grid-cols-2">
              <div className="flex flex-col gap-0.5 border-r border-line px-3.5 py-2.5">
                <dt className="text-[10.5px] font-semibold tracking-[0.07em] text-neutral-600 uppercase">Events</dt>
                <dd className="m-0 font-mono text-[17px] font-bold">{data.event_count}</dd>
              </div>
              <div className="flex flex-col gap-1 border-r border-line px-3.5 py-2.5">
                <dt className="text-[10.5px] font-semibold tracking-[0.07em] text-neutral-600 uppercase">Status</dt>
                <dd className="m-0">{data.http_status !== null ? <StatusBadge code={data.http_status} /> : '·'}</dd>
              </div>
              <div className="flex flex-col gap-0.5 border-r border-line px-3.5 py-2.5">
                <dt className="text-[10.5px] font-semibold tracking-[0.07em] text-neutral-600 uppercase">First seen</dt>
                <dd className="m-0" title={new Date(data.first_seen_at).toLocaleString()}>
                  {ago(data.first_seen_at)}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5 px-3.5 py-2.5">
                <dt className="text-[10.5px] font-semibold tracking-[0.07em] text-neutral-600 uppercase">Last seen</dt>
                <dd className="m-0" title={new Date(data.last_seen_at).toLocaleString()}>
                  {ago(data.last_seen_at)}
                </dd>
              </div>
            </dl>
            <CodeBlock
              text={data.log_line}
              className="m-0 rounded-lg bg-neutral-900 p-3 font-mono text-xs whitespace-pre-wrap break-all text-neutral-100"
            />
            {report && (
              <ReportPanel
                alertId={id}
                report={report}
                sessionId={data.session_id}
                picked={viewed}
                setPicked={setViewed}
              />
            )}
            {data.status === AlertStatus.Dismissed && (
              <div className="rounded-lg border border-dashed border-neutral-400 px-3.5 py-3 text-[13px] text-neutral-700">
                Dismissed. The log stays on the Report and is checked again at the next Scan.{' '}
                <Button
                  variant="ghost"
                  className="px-2 py-0.5 text-xs"
                  title="Take back the dismissal. The Alert goes back to its Report for a Review."
                  disabled={undo.isPending}
                  onClick={() => undo.mutate()}
                >
                  Undo
                </Button>
              </div>
            )}
            {data.fix && (
              <FixProgress fix={data.fix} retrying={retry.isPending} onRetry={(skip) => retry.mutate(skip)} />
            )}
          </>
        )}

        {tab === 'samples' && <SampleList samples={data.samples} source={data.connector} />}

        {tab === 'query' && (
          <section aria-label="Query" className="flex flex-col gap-2">
            <p className="m-0 text-xs text-neutral-700">{QUERY_TIP[data.connector]}</p>
            <CodeBlock
              text={readableQuery(data.connector, data.source_query)}
              className="m-0 rounded-lg bg-neutral-900 p-3 font-mono text-xs whitespace-pre-wrap break-all text-neutral-100"
            />
          </section>
        )}

        {tab === 'history' && (
          <section aria-label="Events">
            <strong className="text-[13px]">Events</strong>{' '}
            <Hint text="Everything that happened to this Alert, oldest first, and who did it" />
            <ol className="m-0 mt-1 list-none p-0 font-mono text-xs">
              {(events.data ?? []).map((event) => (
                <li key={event.id}>
                  <span className="text-neutral-700">{new Date(event.at).toLocaleString()}</span>{' '}
                  {event.kind.replace('_', ' ')} <span className="text-neutral-700">· {event.actor}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      {(canVerify || reviewing) && (
        <footer className="flex flex-none flex-col gap-2.5 border-t border-line bg-card px-5.5 py-3">
          {reviewing && (
            <section aria-label="Review" className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  disabled={review.isPending}
                  title={`Confirm the Report as ${kind === ReportKind.Bug ? 'a bug' : 'an improvement'} and start the Fix: ${fixSteps}`}
                  onClick={() => review.mutate({ decision: ReviewDecision.Confirmed, kind })}
                >
                  {review.isPending && <Spinner />}
                  {withPlaybook('Fix with agent', fixPlaybook)}
                </Button>
                <Button
                  disabled={review.isPending}
                  title={`Confirm it as ${other === ReportKind.Bug ? 'a bug' : 'an improvement'} instead, then start the same Fix`}
                  onClick={() => review.mutate({ decision: ReviewDecision.Confirmed, kind: other })}
                >
                  {withPlaybook(`Fix as ${other}`, fixPlaybook)}
                </Button>
                <Button
                  variant="ghost"
                  disabled={review.isPending}
                  title="Set the Alert aside with no Fix. You can undo it, and a new failure after a healthy Scan reopens it."
                  onClick={() => review.mutate({ decision: ReviewDecision.Dismissed, kind: null })}
                >
                  Dismiss
                </Button>
              </div>
              <span className="text-xs text-neutral-700">
                {data.service.repo_id ? 'In a Session on the local Repo' : 'In an anonymous Session with a clone'}:{' '}
                {ticket ? 'a Jira ticket, then ' : ''}a branch, the Fix Playbook's steps, a push and a pull request.
                {ticket
                  ? ''
                  : jiraUp
                    ? ' The Fix Playbook makes no Jira ticket, so the branch is fix/<name>.'
                    : ' Jira is not connected, so the branch is fix/<name>.'}
              </span>
            </section>
          )}
          {canVerify && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={reviewing ? 'secondary' : 'primary'}
                  disabled={verify.isPending || verifying || !hasCode}
                  title={
                    !hasCode
                      ? "Pick the local Repo with this Service's code above first"
                      : verifying
                        ? 'The agent is verifying. Stop it in the Report to start again.'
                        : 'The agent follows the log through the code in a scratch copy, reads databases only, replays the request where it can, and writes a Report. It changes no code.'
                  }
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
                      title="Run the failed step again and go on from there. Steps already done are kept."
                      onClick={() => retryReport.mutate({ id: report.id })}
                    >
                      {retryReport.isPending && <Spinner />}
                      Retry from step {retryFrom}
                    </Button>
                    <SkipStep
                      small={false}
                      step={retryFrom}
                      disabled={retryReport.isPending || verify.isPending}
                      onSkip={() => retryReport.mutate({ id: report.id, skip: true })}
                    />
                  </>
                )}
                {report?.status === RunStatus.Failed && readingOlder && !verifying && (
                  <span className="min-w-52 flex-1 text-xs text-neutral-700">
                    You are reading an older version. Retry and Skip run on the newest, v{report.version}.
                  </span>
                )}
              </div>
            </div>
          )}
        </footer>
      )}
    </article>
  );
}
