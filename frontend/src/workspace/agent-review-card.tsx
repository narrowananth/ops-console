import { AgentReviewStatus, type PrAgentReview } from '@ops-console/shared';

const MARK = { pass: '✓', warn: '!', fail: '✕', na: '–' } as const;

/** The agent's written review, tied to the commit it read. */
export function AgentReviewCard({ review }: { review: PrAgentReview }) {
  return (
    <section aria-label="Agent Review" className="border-2 border-text">
      <header className="flex items-center gap-2 border-b border-divider bg-surface px-3 py-2 text-xs">
        <strong>Agent Review</strong>
        <span className="font-mono text-neutral-700">{review.head_sha.slice(0, 7)}</span>
        {review.stale && <span className="border border-accent px-1.5 py-px text-[10px] text-accent-700">stale</span>}
        <span className="ml-auto text-neutral-700">{review.status}</span>
      </header>
      <div className="flex flex-col gap-3 px-3 py-2.5 text-[13px]">
        {review.status === AgentReviewStatus.Running && <p className="m-0">The agent is reading the change…</p>}
        {review.status === AgentReviewStatus.Failed && (
          <p className="m-0 text-accent-700">The review did not finish. Start it again.</p>
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
