import { PrAction, PrChecks, PrMergeState, PrReviewState, PrState, type PullRequestDetail } from '@ops-console/shared';
import { ago } from '../monitor/scan-scope';
import { openThreads, roundWorking } from './pr-jobs';

const STATE_TIP: Record<PrState, string> = {
  [PrState.Open]: 'Open: waiting for review and merge',
  [PrState.Merged]: 'Merged into the target branch',
  [PrState.Closed]: 'Closed without merging',
};

/** Up to two initials of a name as the Git host gives it: `Ananth Samuel` → `AS`, `narrowananth` → `NA`. */
function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.slice(0, 2);
  return letters.toUpperCase();
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={`flex flex-none items-center justify-center rounded-full bg-info font-semibold text-white ${size === 'md' ? 'size-9 text-[13px]' : 'size-6 text-[10px]'}`}
    >
      {initials(name)}
    </span>
  );
}

const BRANCH = 'max-w-72 truncate rounded-sm bg-neutral-200 px-1.5 py-0.5 font-mono text-xs text-text';

/** The author's avatar, branch → base, the state when not open, then number, author, age, size and the host link. */
export function PrMeta({ pr }: { pr: PullRequestDetail }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={pr.author} />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span title={`Merging brings ${pr.branch} into ${pr.base_branch}`} className={BRANCH}>
            {pr.branch}
          </span>
          <span aria-hidden className="text-neutral-600">
            →
          </span>
          <span className={BRANCH}>{pr.base_branch}</span>
          {pr.state !== PrState.Open && (
            <span
              title={STATE_TIP[pr.state]}
              className="rounded-sm border border-line px-1.5 py-0.5 text-xs font-medium capitalize"
            >
              {pr.state}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-neutral-700">
          <span className="font-mono">#{pr.number}</span>
          <span aria-hidden>·</span>
          <span title="Author">by {pr.author}</span>
          <span aria-hidden>·</span>
          <span title={`Opened ${new Date(pr.opened_at).toLocaleString()}`}>opened {ago(pr.opened_at)}</span>
          <span aria-hidden>·</span>
          <span title="Lines added and removed across every file" className="font-mono">
            <span className="font-semibold text-diff-add-text">+{pr.additions}</span>{' '}
            <span className="font-semibold text-diff-del-text">−{pr.deletions}</span>
          </span>
          <span aria-hidden>·</span>
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            title={`Open #${pr.number} on ${pr.host} in a new tab`}
            className="font-medium text-text underline"
          >
            Open on the host ↗
          </a>
        </div>
      </div>
    </div>
  );
}

export type Tone = 'ok' | 'bad' | 'run' | 'wait';

const TONE: Record<Tone, string> = {
  ok: 'border-ok text-ok',
  bad: 'border-accent-600 text-accent-700',
  run: 'border-warn text-warn',
  wait: 'border-neutral-400 text-neutral-600',
};

const MARK: Record<Tone, string> = { ok: '✓', bad: '✕', run: '…', wait: '–' };

/** A ring with a mark, coloured by how the thing stands. */
export function ToneMark({ tone }: { tone: Tone }) {
  return (
    <span
      aria-hidden
      className={`flex size-4.5 flex-none items-center justify-center rounded-full border-[1.5px] text-[10px] leading-none font-bold ${TONE[tone]}`}
    >
      {MARK[tone]}
    </span>
  );
}

export type Item = { tone: Tone; title: string; detail?: string; tip: string };

export function checksItem(pr: PullRequestDetail): Item {
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
  if (roundWorking(pr, PrAction.Review)) return { tone: 'run', title: 'Agent reviewing', tip };
  if (!review) return { tone: 'wait', title: 'Not reviewed by the agent', tip };
  return review.stale
    ? { tone: 'wait', title: 'New commit since the agent review', tip }
    : { tone: 'ok', title: 'Agent reviewed this commit', tip };
}

function conflicts(pr: PullRequestDetail): Item | null {
  const check = pr.conflicts;
  if (!check) return null;
  const tip = `Whether ${pr.branch} merges into ${pr.base_branch} as they stand on origin, checked with git`;
  const shown: Record<PrMergeState, Omit<Item, 'tip'>> = {
    [PrMergeState.Checking]: { tone: 'run', title: 'Checking for conflicts' },
    [PrMergeState.Clean]: { tone: 'ok', title: 'No conflicts' },
    [PrMergeState.Conflict]: {
      tone: 'bad',
      title: `${check.files.length} ${check.files.length === 1 ? 'file conflicts' : 'files conflict'}`,
      detail: `with ${pr.base_branch}`,
    },
    [PrMergeState.Unknown]: {
      tone: 'wait',
      title: 'Conflicts not known',
      detail: 'git could not fetch the branch from origin',
    },
  };
  return { ...shown[check.state], tip };
}

/** What stands between this pull request and a merge, one item each. */
export const mergeChecks = (pr: PullRequestDetail): Item[] =>
  [approval(pr), checksItem(pr), conflicts(pr), threads(pr), agentReview(pr)].filter((item) => item !== null);

export function ItemRow({ item }: { item: Item }) {
  return (
    <li title={item.tip} className="flex items-start gap-2.5">
      <ToneMark tone={item.tone} />
      <span className="flex min-w-0 flex-col text-[13px]">
        <span className="font-medium">{item.title}</span>
        {item.detail && <span className="text-xs text-neutral-700">{item.detail}</span>}
      </span>
    </li>
  );
}
