import type { PrCommit, PullRequestDetail } from '@ops-console/shared';
import { useState } from 'react';
import { usePostComment } from '../lib/queries';
import { ago } from '../monitor/scan-scope';
import { Avatar } from './pr-meta';
import { CommentComposer, Thread } from './pr-thread';
import { agentInThread, type ThreadData, threadsOf } from './pr-threads';

enum Filter {
  All = 'all',
  Open = 'open',
  Resolved = 'resolved',
  Agent = 'agent',
}

const FILTER_LABEL: Record<Filter, string> = {
  [Filter.All]: 'All activity',
  [Filter.Open]: 'Open threads',
  [Filter.Resolved]: 'Resolved threads',
  [Filter.Agent]: 'Agent only',
};

type Entry =
  | { kind: 'thread'; at: string; thread: ThreadData }
  | { kind: 'commit'; at: string; commit: PrCommit }
  | { kind: 'review'; at: string; decision: string | null; verdict: string | null };

/** The local day of a time, as the divider names it: "Today", then the date. */
function dayLabel(iso: string): string {
  const at = new Date(iso);
  return at.toDateString() === new Date().toDateString()
    ? 'Today'
    : at.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function entriesOf(pr: PullRequestDetail, filter: Filter): Entry[] {
  const threads = threadsOf(pr).map((thread): Entry => ({ kind: 'thread', at: thread.root.created_at, thread }));
  const review = pr.latest_agent_review;
  const reviews: Entry[] = review
    ? [{ kind: 'review', at: review.created_at, decision: review.decision, verdict: review.verdict }]
    : [];
  const commits = pr.commits.map((commit): Entry => ({ kind: 'commit', at: commit.created_at, commit }));
  const shown = (entry: Entry) => {
    if (entry.kind !== 'thread') return filter === Filter.All || (filter === Filter.Agent && entry.kind === 'review');
    if (filter === Filter.Open) return !entry.thread.root.resolved;
    if (filter === Filter.Resolved) return entry.thread.root.resolved;
    if (filter === Filter.Agent) return agentInThread(entry.thread);
    return true;
  };
  return [...commits, ...reviews, ...threads].filter(shown).sort((a, b) => b.at.localeCompare(a.at));
}

function Event({ entry }: { entry: Exclude<Entry, { kind: 'thread' }> }) {
  const when = <span title={new Date(entry.at).toLocaleString()}>{ago(entry.at)}</span>;
  return (
    <div className="flex items-start gap-2.5 text-[13px] text-neutral-700">
      <Avatar name={entry.kind === 'commit' ? entry.commit.author : 'Agent'} size="sm" />
      <p className="m-0 min-w-0 pt-0.5">
        {entry.kind === 'commit' ? (
          <>
            <strong className="text-text">{entry.commit.author}</strong> pushed{' '}
            <span className="font-mono">{entry.commit.sha.slice(0, 7)}</span> {entry.commit.message} · {when}
          </>
        ) : (
          <>
            <strong className="text-text">Agent Review</strong>{' '}
            {entry.verdict ?? (entry.decision ? `decided ${entry.decision}` : 'reviewed this pull request')} · {when}
          </>
        )}
      </p>
    </div>
  );
}

/** The pull request's Activity: events and comment threads in time order under a divider per day, and a box to comment. */
export function PrActivity({ pr }: { pr: PullRequestDetail }) {
  const comment = usePostComment(pr.repo_id, pr.number);
  const [filter, setFilter] = useState(Filter.All);
  const threads = threadsOf(pr);
  const open = threads.filter((thread) => !thread.root.resolved).length;
  const entries = entriesOf(pr, filter);
  let day = '';
  return (
    <section aria-label="Activity" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="m-0 text-sm font-semibold">Activity</h3>
        <span className="rounded-full bg-accent-100 px-2 py-px text-xs font-semibold text-accent-700">{open} open</span>
        <span className="rounded-full bg-ok/15 px-2 py-px text-xs font-semibold text-ok">
          {threads.length - open} resolved
        </span>
        <select
          aria-label="Filter the activity"
          value={filter}
          onChange={(event) => setFilter(event.target.value as Filter)}
          className="ml-auto cursor-pointer rounded-md border border-divider bg-card px-2.5 py-1 text-xs text-text"
        >
          {Object.values(Filter).map((value) => (
            <option key={value} value={value}>
              {FILTER_LABEL[value]}
            </option>
          ))}
        </select>
      </div>
      <CommentComposer
        label="Comment on the pull request"
        draft={`${pr.repo_id}#${pr.number}.comment`}
        placeholder="What do you want to say?"
        submitLabel="Comment"
        pending={comment.isPending}
        error={comment.error}
        onSubmit={(body, done) => comment.mutate({ body }, { onSuccess: done })}
      />
      {threads.length === 0 && (
        <div className="text-[13px] text-neutral-700">
          No comments yet. Open Files changed, hover a line and press + to comment on it.
        </div>
      )}
      {threads.length > 0 && entries.length === 0 && (
        <div className="text-[13px] text-neutral-700">No thread in this view.</div>
      )}
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {entries.map((entry) => {
          const label = dayLabel(entry.at);
          const divider = label !== day;
          day = label;
          return (
            <li
              key={
                entry.kind === 'thread' ? entry.thread.root.id : entry.kind === 'commit' ? entry.commit.sha : 'review'
              }
              className="flex flex-col gap-2.5"
            >
              {divider && (
                <div className="flex items-center gap-2.5 text-[11px] tracking-wider text-neutral-600 uppercase after:h-px after:flex-1 after:bg-line">
                  {label}
                </div>
              )}
              {entry.kind === 'thread' ? <Thread pr={pr} root={entry.thread.root} /> : <Event entry={entry} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
