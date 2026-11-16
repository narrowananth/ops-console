import { GitHost, PrChecks, PrReviewState, PrState, type PullRequest } from '@ops-console/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { z } from 'zod';
import { Button } from '../components/ui/button';
import { Dropdown } from '../components/ui/dropdown';
import { Empty } from '../components/ui/empty';
import { item } from '../components/ui/item';
import { usePullRequests, useRefreshPullRequests } from '../lib/queries';
import { useStored } from '../lib/remember';
import { ascending } from '../lib/sort';
import { ago } from '../monitor/scan-scope';

type Pull = { repoId: string; number: number };

/** Hosts whose pull requests open in the console; GitLab's are listed and open on GitLab. */
const OPENS_HERE: GitHost[] = [GitHost.Github, GitHost.Bitbucket];

const ANY = 'any';

const CHECKS: Record<PrChecks, string> = {
  [PrChecks.None]: '',
  [PrChecks.Running]: '◐ checks running',
  [PrChecks.Passed]: '✓ checks passed',
  [PrChecks.Failed]: '✕ checks failed',
};

const CHECKS_TIP: Record<PrChecks, string> = {
  [PrChecks.None]: '',
  [PrChecks.Running]: 'CI checks are still running on the newest commit',
  [PrChecks.Passed]: 'Every CI check passed on the newest commit',
  [PrChecks.Failed]: 'At least one CI check failed on the newest commit',
};

const REVIEWS: Record<PrReviewState, string> = {
  [PrReviewState.None]: '',
  [PrReviewState.Approved]: 'approved',
  [PrReviewState.ChangesRequested]: 'changes requested',
};

/** What the operator does next with a pull request, most urgent first. */
type Next = 'changes' | 'failing' | 'review' | 'waiting' | 'ready' | 'done';

const NEXT_ORDER: Next[] = ['changes', 'failing', 'review', 'waiting', 'ready', 'done'];

const NEXT_LABEL: Record<Next, string> = {
  changes: 'Changes requested',
  failing: 'Checks failing',
  review: 'To review',
  waiting: 'Waiting on review',
  ready: 'Ready to merge',
  done: 'Merged or closed',
};

const NEXT_DOT: Record<Next, string> = {
  changes: 'bg-accent',
  failing: 'bg-accent',
  review: 'bg-accent',
  waiting: 'bg-neutral-400',
  ready: 'bg-ok',
  done: 'bg-neutral-300',
};

function nextFor(pr: PullRequest): Next {
  if (pr.state !== PrState.Open) return 'done';
  if (pr.review_state === PrReviewState.ChangesRequested) return 'changes';
  if (pr.checks === PrChecks.Failed) return 'failing';
  if (pr.review_state === PrReviewState.Approved || pr.approved_by.length > 0) return 'ready';
  return pr.is_mine ? 'waiting' : 'review';
}

/** `value`, once it has stood still for `ms`: a number typed in the search asks the Git host, so keystrokes wait. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** The repository's own name: `name` of `owner/name`. */
const shortName = (slug: string) => slug.slice(slug.lastIndexOf('/') + 1);

const projectKey = (pr: PullRequest) => `${pr.host}:${pr.slug.toLowerCase()}`;

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-xs transition-colors ${on ? 'border-text bg-text text-white' : 'border-line bg-transparent text-neutral-800 hover:bg-neutral-200'}`}
    >
      {children}
    </button>
  );
}

function PullRow({
  pr,
  next,
  selected,
  onSelect,
}: {
  pr: PullRequest;
  next: Next;
  selected: Pull | null;
  onSelect: (pull: Pull) => void;
}) {
  const repoId = pr.repo_id;
  const here = repoId !== null && OPENS_HERE.includes(pr.host);
  const active = here && selected?.repoId === repoId && selected.number === pr.number;
  const body = (
    <>
      <span className="flex w-full items-center gap-2">
        <span aria-hidden className={`size-2 flex-none rounded-full ${NEXT_DOT[next]}`} />
        <span className="min-w-0 truncate font-semibold">
          #{pr.number} {pr.title}
        </span>
        <span
          className="ml-auto flex-none font-mono text-xs font-normal text-neutral-700"
          title={`Opened ${new Date(pr.opened_at).toLocaleString()}`}
        >
          {ago(pr.opened_at)}
        </span>
        {!here && (
          <span aria-hidden className="flex-none text-xs font-normal text-neutral-600">
            ↗
          </span>
        )}
      </span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-4 text-xs text-neutral-700">
        <span title={pr.slug} className="max-w-[45%] truncate rounded-full bg-neutral-200 px-1.75 font-mono">
          {shortName(pr.slug)}
        </span>
        <span>{pr.author}</span>
        {pr.state !== PrState.Open && <span className="rounded-full bg-neutral-200 px-1.75">{pr.state}</span>}
        {CHECKS[pr.checks] && (
          <span title={CHECKS_TIP[pr.checks]} className={pr.checks === PrChecks.Failed ? 'text-accent-700' : ''}>
            {CHECKS[pr.checks]}
          </span>
        )}
        {pr.approved_by.length > 0 ? (
          <span className="text-ok">✓ approved by {pr.approved_by.join(', ')}</span>
        ) : (
          REVIEWS[pr.review_state] && (
            <span className={pr.review_state === PrReviewState.ChangesRequested ? 'text-accent-700' : ''}>
              {REVIEWS[pr.review_state]}
            </span>
          )
        )}
        {pr.comment_count > 0 && <span>{pr.comment_count} comments</span>}
        {pr.by_agent && <span title="A Session in the console worked on this branch">agent</span>}
        {repoId === null && (
          <span title="Not imported as a Repo: its pull requests open on the Git host. Import it in Repos to review them here.">
            not imported
          </span>
        )}
      </span>
    </>
  );
  const look = `flex w-full flex-col gap-0.5 px-3 py-2 text-[13px] no-underline ${item(active)}`;
  return (
    <li>
      {here ? (
        <button
          type="button"
          aria-current={active}
          onClick={() => onSelect({ repoId, number: pr.number })}
          className={look}
        >
          {body}
        </button>
      ) : (
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          title={`Opens on ${pr.host} in a new tab: only imported GitHub and Bitbucket pull requests open in the console`}
          className={look}
        >
          {body}
        </a>
      )}
    </li>
  );
}

export function PullRequestsPane({ selected, onSelect }: { selected: Pull | null; onSelect: (pull: Pull) => void }) {
  const [mine, setMine] = useStored('workspace.pr-mine', z.boolean(), true);
  const [q, setQ] = useStored('workspace.pr-search', z.string(), '');
  const [filter, setFilter] = useStored('workspace.pr-filter', z.enum(['all', 'review', 'failing']), 'all');
  const [project, setProject] = useStored('workspace.pr-project', z.string(), ANY);
  const settled = useSettled(q.trim(), 400);
  const pulls = usePullRequests({ mine, q: settled });
  const refresh = useRefreshPullRequests();

  const everything = pulls.data?.data ?? [];
  const projects = ascending(
    [...new Map(everything.map((pr) => [projectKey(pr), pr.slug])).entries()],
    ([, slug]) => slug,
  );
  const picked = projects.some(([key]) => key === project) ? project : ANY;
  const inProject = everything.filter((pr) => picked === ANY || projectKey(pr) === picked);
  const counts = {
    all: inProject.length,
    review: inProject.filter((pr) => nextFor(pr) === 'review').length,
    failing: inProject.filter((pr) => nextFor(pr) === 'failing').length,
  };
  const listed = inProject.filter((pr) => filter === 'all' || nextFor(pr) === filter);

  return (
    <div className="pb-3">
      <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-divider bg-bg px-3 pt-1 pb-2.5">
        <div className="flex items-center gap-1.5">
          <fieldset
            aria-label="Whose pull requests"
            className="m-0 flex flex-1 gap-0.5 rounded-lg border-0 bg-neutral-200 p-0.75"
          >
            {(
              [
                [true, 'Mine'],
                [false, 'All'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={label}
                type="button"
                title={
                  value
                    ? 'Pull requests you opened, and the ones on a branch a Session worked on'
                    : 'Every open pull request in the repositories you can read on your connected Git hosts'
                }
                aria-pressed={mine === value}
                onClick={() => setMine(value)}
                className={`flex-1 cursor-pointer rounded-md border-0 py-1 text-xs transition-colors ${mine === value ? 'bg-card font-semibold text-text shadow-sm' : 'bg-transparent text-neutral-700 hover:text-text'}`}
              >
                {label}
              </button>
            ))}
          </fieldset>
          <Button
            icon
            className="size-7.5 flex-none text-neutral-700 hover:text-text"
            aria-label="Refresh pull requests"
            title="Read the Git hosts again now. Otherwise they are read every 30 minutes."
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              aria-hidden
              className={refresh.isPending || pulls.isFetching ? 'animate-spin' : ''}
            >
              <path
                d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Button>
        </div>
        <div className="relative">
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-neutral-600"
          >
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            aria-label="Search pull requests"
            value={q}
            placeholder={mine ? 'Search number, title or your email' : 'Search number, title or author'}
            onChange={(event) => setQ(event.target.value)}
            className="w-full rounded-md border border-divider bg-card py-1.5 pr-2.5 pl-7.5 text-xs text-text outline-none focus:border-accent-400 focus:shadow-[0_0_0_3px_var(--color-accent-100)]"
          />
        </div>
        {/^#?\d+$/.test(settled) && pulls.isFetching && (
          <div role="status" className="px-0.5 text-xs text-neutral-700">
            Asking the Git hosts for #{settled.replace('#', '')}…
          </div>
        )}
        {everything.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip on={filter === 'all'} onClick={() => setFilter('all')}>
              All {counts.all}
            </Chip>
            <Chip on={filter === 'review'} onClick={() => setFilter('review')}>
              To review {counts.review}
            </Chip>
            <Chip on={filter === 'failing'} onClick={() => setFilter('failing')}>
              Failing {counts.failing}
            </Chip>
            <Dropdown
              label="Filter by project"
              caption="Project"
              variant="chip"
              opens="down"
              align="left"
              searchable
              value={picked}
              options={[
                { value: ANY, label: 'All projects', description: `${everything.length} pull requests` },
                ...projects.map(([key, slug]) => ({
                  value: key,
                  label: slug,
                  description: `${everything.filter((pr) => projectKey(pr) === key).length} pull requests`,
                })),
              ]}
              onChange={setProject}
              listClassName="w-max min-w-52 max-w-md"
            />
          </div>
        )}
      </div>
      {pulls.isPending ? (
        <Empty>Reading pull requests…</Empty>
      ) : pulls.isError ? (
        <Empty>Could not read pull requests: {pulls.error.message}</Empty>
      ) : (
        <>
          {pulls.data.meta.stale && (
            <div role="status" className="mx-3 mt-2 rounded-md bg-accent-100 px-3 py-2 text-xs text-accent-700">
              The Git host did not answer. Showing what was read at{' '}
              {pulls.data.meta.synced_at && new Date(pulls.data.meta.synced_at).toLocaleTimeString()}.
            </div>
          )}
          {everything.length === 0 ? (
            <Empty>
              {settled !== ''
                ? `No ${mine ? 'pull requests of yours' : 'pull requests'} match “${settled}”.`
                : mine
                  ? 'No open pull requests of yours.'
                  : 'No open pull requests.'}
            </Empty>
          ) : listed.length === 0 ? (
            <Empty>No pull request in this view.</Empty>
          ) : (
            NEXT_ORDER.map((next) => {
              const group = listed.filter((pr) => nextFor(pr) === next);
              return (
                group.length > 0 && (
                  <section key={next} aria-label={NEXT_LABEL[next]} className="px-2 pb-1">
                    <h3 className="m-0 flex items-center px-2 pt-3 pb-1 text-[11px] font-semibold tracking-[0.08em] text-neutral-700 uppercase">
                      {NEXT_LABEL[next]}
                      <span className="ml-auto font-mono font-normal tracking-normal">{group.length}</span>
                    </h3>
                    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                      {group.map((pr) => (
                        <PullRow
                          key={`${projectKey(pr)}#${pr.number}`}
                          pr={pr}
                          next={next}
                          selected={selected}
                          onSelect={onSelect}
                        />
                      ))}
                    </ul>
                  </section>
                )
              );
            })
          )}
        </>
      )}
    </div>
  );
}
