import { AgentReviewStatus, PrChecks, PrReviewState, PrState, type PullRequestDetail } from '@ops-console/shared';
import type { ReactNode } from 'react';
import { openThreads } from './pr-jobs';

const STATE_TIP: Record<PrState, string> = {
  [PrState.Open]: 'Open: waiting for review and merge',
  [PrState.Merged]: 'Merged into the target branch',
  [PrState.Closed]: 'Closed without merging',
};

/** Branch, author, size and comments on one line under the title; the verdict lives in the rail. */
export function PrMeta({ pr }: { pr: PullRequestDetail }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-800">
      {pr.state !== PrState.Open && (
        <span
          title={STATE_TIP[pr.state]}
          className="rounded-full border border-line bg-card px-2.5 py-0.5 text-xs font-medium capitalize"
        >
          {pr.state}
        </span>
      )}
      <span title={`Merging brings ${pr.branch} into ${pr.base_branch}`} className="font-mono">
        {pr.branch} → {pr.base_branch}
      </span>
      <span title="Author">by {pr.author}</span>
      <span title="Lines added and removed across every file" className="font-mono">
        <span className="font-semibold text-diff-add-text">+{pr.additions}</span>{' '}
        <span className="font-semibold text-diff-del-text">−{pr.deletions}</span>
      </span>
      <span title="Comments on the Git host, and how many of their threads are resolved">
        {pr.comment_count} comments · {pr.resolved_count} resolved
      </span>
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
  );
}

type Tone = 'ok' | 'bad' | 'run' | 'wait';

const TONE: Record<Tone, string> = {
  ok: 'bg-ok',
  bad: 'bg-accent-600',
  run: 'bg-warn',
  wait: 'bg-neutral-500',
};

const MARK: Record<Tone, string> = { ok: '✓', bad: '!', run: '…', wait: '–' };

type Item = { tone: Tone; title: string; detail?: string; tip: string };

function checks(pr: PullRequestDetail): Item {
  const tip: Record<PrChecks, string> = {
    [PrChecks.None]: 'No CI checks reported on the newest commit',
    [PrChecks.Running]: 'CI checks are still running on the newest commit',
    [PrChecks.Passed]: 'Every CI check passed on the newest commit',
    [PrChecks.Failed]: 'At least one CI check failed on the newest commit. Open it on the host to see which.',
  };
  const shown: Record<PrChecks, Omit<Item, 'tip'>> = {
    [PrChecks.None]: { tone: 'wait', title: 'No checks reported' },
    [PrChecks.Running]: { tone: 'run', title: 'Checks running' },
    [PrChecks.Passed]: { tone: 'ok', title: 'Checks passed' },
    [PrChecks.Failed]: { tone: 'bad', title: 'Checks failed', detail: 'Open it on the host to see which' },
  };
  return { ...shown[pr.checks], tip: tip[pr.checks] };
}

function approval(pr: PullRequestDetail): Item {
  if (pr.approved_by.length > 0) {
    return {
      tone: 'ok',
      title: `Approved by ${pr.approved_by.join(', ')}`,
      tip: `Approved by ${pr.approved_by.join(', ')}`,
    };
  }
  if (pr.review_state === PrReviewState.ChangesRequested) {
    return { tone: 'bad', title: 'Changes requested', tip: 'A reviewer asked for changes' };
  }
  return {
    tone: 'wait',
    title: 'No approval yet',
    detail: 'Merge unlocks once a reviewer approves',
    tip: 'Nobody has approved or asked for changes yet',
  };
}

function threads(pr: PullRequestDetail): Item {
  const open = openThreads(pr).length;
  return open > 0
    ? {
        tone: 'bad',
        title: `${open} ${open === 1 ? 'thread' : 'threads'} open`,
        detail: `${pr.resolved_count} resolved`,
        tip: 'Unresolved comment threads on the Git host',
      }
    : {
        tone: 'ok',
        title: 'No open threads',
        detail: `${pr.resolved_count} resolved`,
        tip: 'Every comment thread on the Git host is resolved',
      };
}

function agentReview(pr: PullRequestDetail): Item {
  const review = pr.latest_agent_review;
  const tip = 'The agent review of the newest commit';
  if (!review) return { tone: 'wait', title: 'Not reviewed by the agent', tip };
  if (review.status === AgentReviewStatus.Running) return { tone: 'run', title: 'Agent reviewing', tip };
  if (review.status === AgentReviewStatus.Failed) return { tone: 'bad', title: 'Agent review failed', tip };
  return review.stale
    ? { tone: 'wait', title: 'New commit since the agent review', tip }
    : { tone: 'ok', title: 'Agent reviewed this commit', tip };
}

function Row({ item }: { item: Item }) {
  return (
    <li title={item.tip} className="flex items-start gap-2.5 border-t border-line py-2 first:border-t-0 first:pt-0">
      <span
        aria-hidden
        className={`mt-0.5 flex size-4.5 flex-none items-center justify-center rounded-full text-[11px] font-bold text-white ${TONE[item.tone]}`}
      >
        {MARK[item.tone]}
      </span>
      <span className="flex min-w-0 flex-col text-[13px]">
        <span className="font-semibold">{item.title}</span>
        {item.detail && <span className="text-xs text-neutral-700">{item.detail}</span>}
      </span>
    </li>
  );
}

/** What stands between this pull request and a merge, one line each. */
export function PrReadiness({ pr, heading }: { pr: PullRequestDetail; heading: ReactNode }) {
  const items = [approval(pr), checks(pr), threads(pr), agentReview(pr)];
  return (
    <section aria-label="Merge readiness" className="flex flex-col gap-2">
      {heading}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((item) => (
          <Row key={item.title} item={item} />
        ))}
      </ul>
    </section>
  );
}
