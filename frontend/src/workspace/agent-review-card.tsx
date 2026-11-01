import { AgentReviewStatus, type PrAgentReview } from '@ops-console/shared';
import { StopRun } from '../agents/stop-run';
import { StatusPill } from '../components/ui/pathway';
import { JobPath, PlaybookLink, runState } from '../playbooks/job-steps';

const MARK = { pass: '✓', warn: '!', fail: '✕', na: '–' } as const;

/** The agent's written review, tied to the commit it read. */
export function AgentReviewCard({ review, sessionId }: { review: PrAgentReview; sessionId: string | null }) {
  return (
    <section aria-label="Agent Review" className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
      <header className="flex items-center gap-2 border-b border-divider bg-surface px-3 py-2 text-xs">
        <strong>Agent Review</strong>
        <span className="font-mono text-neutral-700">{review.head_sha.slice(0, 7)}</span>
        {review.stale && (
          <span className="rounded-full bg-accent-100 px-2 py-px text-[10px] text-accent-700">stale</span>
        )}
        {review.playbook && <PlaybookLink playbook={review.playbook} />}
        <span className="ml-auto flex items-center gap-2">
          {review.status === AgentReviewStatus.Running && sessionId && (
            <StopRun sessionId={sessionId} title="Stop the review; it fails and can start again" />
          )}
          <StatusPill state={runState(review.status)}>{review.status}</StatusPill>
        </span>
      </header>
      <div className="flex flex-col gap-3 px-3 py-2.5 text-[13px]">
        {review.status === AgentReviewStatus.Failed && (
          <p role="alert" className="m-0 text-accent-700">
            The review did not finish. Start it again.
          </p>
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
          />
        )}
        {review.verdict && <p className="m-0 font-bold">{review.verdict}</p>}
        {review.findings.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {review.findings.map((finding) => (
              <li key={`${finding.file}:${finding.line}:${finding.text}`}>
                <span className="font-bold">{finding.severity}</span>
                {finding.file && (
                  <span className="font-mono text-xs text-neutral-700">
                    {' '}
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ''}
                  </span>
                )}
                <div>{finding.text}</div>
                {finding.post_error && (
                  <div className="text-xs text-accent-700">Not posted to the host: {finding.post_error}</div>
                )}
              </li>
            ))}
          </ul>
        )}
        {review.checklist.length > 0 && (
          <div>
            <div className="text-[10px] tracking-[0.08em] text-neutral-700 uppercase">PROD readiness</div>
            <ul className="m-0 list-none p-0">
              {review.checklist.map((item) => (
                <li key={item.item}>
                  {MARK[item.status]} {item.item}
                  {item.note && <span className="text-neutral-700"> · {item.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {review.tools.length > 0 && (
          <div>
            <div className="text-[10px] tracking-[0.08em] text-neutral-700 uppercase">Connections queried</div>
            <ul className="m-0 list-none p-0 font-mono text-xs">
              {review.tools.map((tool) => (
                <li key={`${tool.connection}:${tool.query}`}>
                  {tool.connection}: {tool.query} → {tool.result}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
