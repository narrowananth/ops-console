import {
  AgentReviewStatus,
  FINDING_SEVERITIES,
  FindingSeverity,
  type PrAgentReview,
  ReviewVerdict,
} from '@ops-console/shared';
import { StopRun } from '../agents/stop-run';
import { Elapsed } from '../components/ui/elapsed';
import { FoldTitle, useFold } from '../components/ui/fold';
import { Markdown } from '../components/ui/markdown';
import { StatusPill } from '../components/ui/pathway';
import { Hint } from '../components/ui/tip';
import { useRetryAgentReview, useSkipRunningStep } from '../lib/queries';
import { JobFailure, JobPath, PlaybookLink, runState, SkillsOffered } from '../playbooks/job-steps';

const MARK = { pass: '✓', warn: '!', fail: '✕', na: '–' } as const;

const MARK_TIP = { pass: 'Passed', warn: 'Needs a look', fail: 'Failed', na: 'Does not apply' } as const;

const VERDICT: Record<ReviewVerdict, { label: string; className: string; tip: string }> = {
  [ReviewVerdict.Approve]: {
    label: 'APPROVE',
    className: 'border-ok/40 bg-ok/10 text-ok',
    tip: 'No blocking finding and the PROD readiness checks met. The agent does not approve on the Git host: that stays yours.',
  },
  [ReviewVerdict.RequestChanges]: {
    label: 'REQUEST CHANGES',
    className: 'border-accent-200 bg-accent-100 text-accent-700',
    tip: 'The agent found a defect or a production risk that should be fixed before merging.',
  },
  [ReviewVerdict.Comment]: {
    label: 'COMMENT',
    className: 'border-divider bg-neutral-200 text-neutral-700',
    tip: 'Notes worth reading, but nothing that blocks a merge.',
  },
};

const SEVERITY: Record<FindingSeverity, { label: string; className: string; tip: string }> = {
  [FindingSeverity.Critical]: {
    label: 'Critical',
    className: 'bg-accent-700 text-white',
    tip: 'Critical: a security hole, data corruption or a major production failure.',
  },
  [FindingSeverity.High]: {
    label: 'High',
    className: 'bg-accent-100 text-accent-700',
    tip: 'High: a significant functional failure, a breaking change or a serious regression.',
  },
  [FindingSeverity.Medium]: {
    label: 'Medium',
    className: 'bg-warn/15 text-warn',
    tip: 'Medium: wrong behaviour in specific scenarios.',
  },
  [FindingSeverity.Low]: {
    label: 'Low',
    className: 'bg-neutral-200 text-neutral-700',
    tip: 'Low: a minor issue.',
  },
  [FindingSeverity.Info]: {
    label: 'Info',
    className: 'bg-neutral-200 text-neutral-600',
    tip: 'Info: a suggestion that blocks nothing.',
  },
};

const rank = (severity: FindingSeverity) => FINDING_SEVERITIES.indexOf(severity);

/** The agent's written review, tied to the commit it read. */
export function AgentReviewCard({ review, sessionId }: { review: PrAgentReview; sessionId: string | null }) {
  const skipStep = useSkipRunningStep('agent_review', review.id);
  const retry = useRetryAgentReview(review.repo_id, review.pr_number);
  const [folded, toggle] = useFold('agent-review');
  return (
    <section aria-label="Agent Review" className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
      <header
        className={`flex items-center gap-2 bg-surface px-3 py-2 text-xs ${folded ? '' : 'border-b border-divider'}`}
      >
        <FoldTitle label="Agent Review" folded={folded} onToggle={toggle}>
          <strong>Agent Review</strong>
        </FoldTitle>
        <span title="The commit the agent reviewed" className="font-mono text-neutral-700">
          {review.head_sha.slice(0, 7)}
        </span>
        {review.stale && (
          <span
            title="The pull request has newer commits than this review read. Run Agent Review again to review them."
            className="rounded-full bg-accent-100 px-2 py-px text-xs text-accent-700"
          >
            stale
          </span>
        )}
        {review.playbook && <PlaybookLink playbook={review.playbook} />}
        {review.playbook && <SkillsOffered playbook={review.playbook} />}
        {review.decision && (
          <span
            title={VERDICT[review.decision].tip}
            className={`rounded-full border px-2 py-px text-xs font-semibold tracking-[0.04em] ${VERDICT[review.decision].className}`}
          >
            {VERDICT[review.decision].label}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {review.status === AgentReviewStatus.Running && sessionId && (
            <StopRun sessionId={sessionId} title="Stop the review; it fails and can start again" />
          )}
          <Elapsed
            from={review.started_at}
            to={review.finished_at}
            running={review.status === AgentReviewStatus.Running}
            took
          />
          <StatusPill state={runState(review.status)}>{review.status}</StatusPill>
        </span>
      </header>
      <div hidden={folded} className="flex flex-col gap-3 px-3 py-2.5 text-[13px]">
        {review.status === AgentReviewStatus.Failed && (
          <JobFailure
            error={
              review.stale
                ? 'The review did not finish, and the pull request has new commits. Review it again.'
                : `The review did not finish${review.error ? `: ${review.error}` : ''}.`
            }
            playbook={review.playbook}
            canRetry={!review.stale}
            retry={{
              isPending: retry.isPending,
              error: retry.error,
              mutate: (skip) => retry.mutate({ id: review.id, skip }),
            }}
          />
        )}
        {(review.status !== AgentReviewStatus.Ready || (review.playbook && review.playbook.steps.length > 0)) && (
          <JobPath
            playbook={review.playbook}
            status={review.status}
            reading={{ todo: 'Read the change', doing: 'Reading the change' }}
            closing={{
              todo: 'Write findings, checklist and verdict',
              doing: 'Writing findings, checklist and verdict',
            }}
            skip={{ isPending: skipStep.isPending, error: skipStep.error, mutate: () => skipStep.mutate() }}
          />
        )}
        {review.note && (
          <p className="m-0 whitespace-pre-wrap text-xs text-neutral-700">
            <strong>Your note:</strong> {review.note}
          </p>
        )}
        {review.verdict && <p className="m-0 font-semibold">{review.verdict}</p>}
        {review.status === AgentReviewStatus.Ready && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-700">
            <span>
              Reviewed <span className="font-mono">{review.head_sha.slice(0, 7)}</span>
              {review.base_branch && (
                <>
                  {' '}
                  against {review.base_branch}
                  {review.base_sha ? (
                    <>
                      {' '}
                      at <span className="font-mono">{review.base_sha.slice(0, 7)}</span>
                    </>
                  ) : (
                    <span title="The target branch could not be fetched, so the change was read on its own">
                      {' (not fetched)'}
                    </span>
                  )}
                </>
              )}
            </span>
            <span>{new Date(review.created_at).toLocaleString()}</span>
            {/* biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; these are counts */}
            <span role="group" aria-label="Findings by severity" className="flex flex-wrap gap-1.5">
              {FINDING_SEVERITIES.map((severity) => {
                const count = review.findings.filter((finding) => finding.severity === severity).length;
                return (
                  <span
                    key={severity}
                    title={SEVERITY[severity].tip}
                    className={`rounded-full px-2 py-px text-xs font-semibold ${count > 0 ? SEVERITY[severity].className : 'bg-neutral-100 text-neutral-500'}`}
                  >
                    {count} {SEVERITY[severity].label}
                  </span>
                );
              })}
            </span>
          </div>
        )}
        {review.findings.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {[...review.findings]
              .sort((a, b) => rank(a.severity) - rank(b.severity))
              .map((finding) => (
                <li key={`${finding.file}:${finding.line}:${finding.text}`}>
                  <span
                    title={SEVERITY[finding.severity].tip}
                    className={`rounded-full px-2 py-px text-xs font-semibold ${SEVERITY[finding.severity].className}`}
                  >
                    {SEVERITY[finding.severity].label}
                  </span>
                  {finding.file && (
                    <span className="font-mono text-xs text-neutral-700">
                      {' '}
                      {finding.file}
                      {finding.line ? `:${finding.line}` : ''}
                    </span>
                  )}
                  <div>{finding.text}</div>
                  {finding.post_error && (
                    <div
                      title="The Git host refused this finding. It is kept here only."
                      className="text-xs text-accent-700"
                    >
                      Not posted to the host: {finding.post_error}
                    </div>
                  )}
                </li>
              ))}
          </ul>
        )}
        {review.checklist.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-xs tracking-[0.08em] text-neutral-700 uppercase">
              PROD readiness
              <Hint text="Is the change safe to ship? Correctness, security, database safety, API compatibility, performance, logging, deployment and rollback. ✓ passed, ! needs a look, ✕ failed, – does not apply." />
            </div>
            <ul className="m-0 list-none p-0">
              {review.checklist.map((item) => (
                <li key={item.item}>
                  <span title={MARK_TIP[item.status]}>{MARK[item.status]}</span> {item.item}
                  {item.note && <span className="text-neutral-700"> · {item.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {review.tools.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-xs tracking-[0.08em] text-neutral-700 uppercase">
              Connections queried
              <Hint text="Every Connection and repository the agent used to check the change, what it looked at, and what that showed." />
            </div>
            <ul className="m-0 list-none p-0 font-mono text-xs">
              {review.tools.map((tool) => (
                <li key={`${tool.connection}:${tool.query}`}>
                  {tool.connection}: {tool.query} → {tool.result}
                </li>
              ))}
            </ul>
          </div>
        )}
        {review.report && (
          <details>
            <summary
              title="The agent's whole written review. The same text is in its summary comment on the Git host."
              className="cursor-pointer text-xs text-neutral-700"
            >
              Full report
            </summary>
            <Markdown source={review.report} className="mt-2" />
          </details>
        )}
      </div>
    </section>
  );
}
