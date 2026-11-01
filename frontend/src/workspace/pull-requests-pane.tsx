import { PrChecks, PrReviewState } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { item } from '../components/ui/item';
import { usePullRequests, useRefreshPullRequests, useRepos } from '../lib/queries';

type Pull = { repoId: string; number: number };

const CHECKS: Record<PrChecks, string> = {
  [PrChecks.None]: '',
  [PrChecks.Running]: '◐ checks running',
  [PrChecks.Passed]: '✓ checks passed',
  [PrChecks.Failed]: '✕ checks failed',
};

const REVIEWS: Record<PrReviewState, string> = {
  [PrReviewState.None]: '',
  [PrReviewState.Approved]: 'approved',
  [PrReviewState.ChangesRequested]: 'changes requested',
};

export function PullRequestsPane({ selected, onSelect }: { selected: Pull | null; onSelect: (pull: Pull) => void }) {
  const [mine, setMine] = useState(true);
  const [q, setQ] = useState('');
  const pulls = usePullRequests({ mine, q });
  const refresh = useRefreshPullRequests();
  const repos = useRepos();
  const repoName = (id: string) => repos.data?.data.find((repo) => repo.id === id)?.name ?? '';

  return (
    <div>
      <div className="flex flex-col gap-2 px-3 pt-1 pb-3">
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5 rounded-full bg-neutral-200 p-0.5">
            {(
              [
                [true, 'Mine'],
                [false, 'All'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={label}
                type="button"
                aria-pressed={mine === value}
                onClick={() => setMine(value)}
                className={`cursor-pointer rounded-full border-0 px-3 py-1 text-xs transition-colors ${mine === value ? 'bg-card font-bold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <Button className="ml-auto px-2.5 py-1 text-xs" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            Refresh
          </Button>
        </div>
        <input
          aria-label="Search pull requests"
          value={q}
          placeholder="Search title, author, branch"
          onChange={(event) => setQ(event.target.value)}
          className="border border-divider bg-card px-3 py-1.75 text-xs text-text"
        />
      </div>
      {pulls.isPending ? (
        <Empty>Reading pull requests…</Empty>
      ) : pulls.isError ? (
        <Empty>Could not read pull requests: {pulls.error.message}</Empty>
      ) : (
        <>
          {pulls.data.meta.stale && (
            <div role="status" className="mx-3 mb-2 rounded-md bg-accent-100 px-3 py-2 text-xs text-accent-700">
              The Git host did not answer. Showing what was read at{' '}
              {pulls.data.meta.synced_at && new Date(pulls.data.meta.synced_at).toLocaleTimeString()}.
            </div>
          )}
          {pulls.data.data.length === 0 ? (
            <Empty>No open pull requests.</Empty>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-0.5 px-2 pb-3">
              {pulls.data.data.map((pr) => {
                const active = selected?.repoId === pr.repo_id && selected.number === pr.number;
                return (
                  <li key={`${pr.repo_id}#${pr.number}`}>
                    <button
                      type="button"
                      aria-current={active}
                      onClick={() => onSelect({ repoId: pr.repo_id, number: pr.number })}
                      className={`flex w-full flex-col gap-0.5 px-3 py-2 text-[13px] ${item(active)}`}
                    >
                      <span className="truncate font-bold">
                        #{pr.number} {pr.title}
                      </span>
                      <span className="flex flex-wrap gap-x-2 font-mono text-[11px] text-neutral-700">
                        <span>{repoName(pr.repo_id)}</span>
                        <span>{pr.author}</span>
                        {pr.by_agent && <span>agent</span>}
                        {CHECKS[pr.checks] && <span>{CHECKS[pr.checks]}</span>}
                        {REVIEWS[pr.review_state] && <span>{REVIEWS[pr.review_state]}</span>}
                        {pr.comment_count > 0 && (
                          <span>
                            {pr.comment_count} comments · {pr.resolved_count} resolved
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
