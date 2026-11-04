import { PrChecks, PrReviewState, PrState, type PullRequestDetail } from '@ops-console/shared';
import type { ReactNode } from 'react';

const STATE_TIP: Record<PrState, string> = {
  [PrState.Open]: 'Open: waiting for review and merge',
  [PrState.Merged]: 'Merged into the target branch',
  [PrState.Closed]: 'Closed without merging',
};

const CHECKS_TIP: Record<PrChecks, string> = {
  [PrChecks.None]: 'No CI checks reported on the newest commit',
  [PrChecks.Running]: 'CI checks are still running on the newest commit',
  [PrChecks.Passed]: 'Every CI check passed on the newest commit',
  [PrChecks.Failed]: 'At least one CI check failed on the newest commit. Open it on the host to see which.',
};

const REVIEW_TIP: Record<PrReviewState, string> = {
  [PrReviewState.None]: 'Nobody has approved or asked for changes yet',
  [PrReviewState.Approved]: 'A reviewer approved it',
  [PrReviewState.ChangesRequested]: 'A reviewer asked for changes',
};

type Tone = 'ok' | 'warn' | 'bad' | 'plain';

const TONE: Record<Tone, string> = {
  ok: 'border-ok/30 bg-ok/10 text-ok',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  bad: 'border-accent-300 bg-accent-100 text-accent-700',
  plain: 'border-line bg-card text-neutral-800',
};

const DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-accent-600',
  plain: 'bg-neutral-500',
};

const STATE_TONE: Record<PrState, Tone> = {
  [PrState.Open]: 'ok',
  [PrState.Merged]: 'plain',
  [PrState.Closed]: 'bad',
};

const CHECKS_TONE: Record<PrChecks, Tone> = {
  [PrChecks.None]: 'plain',
  [PrChecks.Running]: 'warn',
  [PrChecks.Passed]: 'ok',
  [PrChecks.Failed]: 'bad',
};

const REVIEW_TONE: Record<PrReviewState, Tone> = {
  [PrReviewState.None]: 'plain',
  [PrReviewState.Approved]: 'ok',
  [PrReviewState.ChangesRequested]: 'bad',
};

function Chip({ tone, title, children }: { tone: Tone; title: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium capitalize ${TONE[tone]}`}
    >
      <span aria-hidden className={`size-2 rounded-full ${DOT[tone]}`} />
      {children}
    </span>
  );
}

function Fact({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <div title={title} className="flex flex-col gap-0.5">
      <dt className="text-xs tracking-[0.08em] text-neutral-700 uppercase">{label}</dt>
      <dd className="m-0 text-sm text-text">{children}</dd>
    </div>
  );
}

/** What a reader scans first: state, checks and review as chips, then branch, author, size and comments, labelled. */
export function PrMeta({ pr }: { pr: PullRequestDetail }) {
  const approved = pr.approved_by.length > 0;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-card px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={STATE_TONE[pr.state]} title={STATE_TIP[pr.state]}>
          {pr.state}
        </Chip>
        <Chip tone={CHECKS_TONE[pr.checks]} title={CHECKS_TIP[pr.checks]}>
          Checks {pr.checks}
        </Chip>
        {approved ? (
          <Chip tone="ok" title={`Approved by ${pr.approved_by.join(', ')}`}>
            Approved by {pr.approved_by.join(', ')}
          </Chip>
        ) : (
          <Chip tone={REVIEW_TONE[pr.review_state]} title={REVIEW_TIP[pr.review_state]}>
            Review {pr.review_state.replace('_', ' ')}
          </Chip>
        )}
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          title={`Open #${pr.number} on ${pr.host} in a new tab`}
          className="ml-auto text-sm font-medium text-text underline"
        >
          Open on the host ↗
        </a>
      </div>
      <dl className="m-0 flex flex-wrap gap-x-8 gap-y-2">
        <Fact label="Branch" title={`Merging brings ${pr.branch} into ${pr.base_branch}`}>
          <span className="font-mono">
            {pr.branch} → {pr.base_branch}
          </span>
        </Fact>
        <Fact label="Author" title="Author">
          {pr.author}
        </Fact>
        <Fact label="Changes" title="Lines added and removed across every file">
          <span className="font-mono">
            <span className="font-semibold text-diff-add-text">+{pr.additions}</span>{' '}
            <span className="font-semibold text-diff-del-text">−{pr.deletions}</span>
          </span>
        </Fact>
        <Fact label="Comments" title="Comments on the Git host, and how many of their threads are resolved">
          {pr.comment_count} · {pr.resolved_count} resolved
        </Fact>
      </dl>
    </div>
  );
}
