import { GitHost, PrChecks, PrReviewState, type PullRequest } from '@ops-console/shared';
import { useState } from 'react';
import { z } from 'zod';
import { BrandIcon } from '../components/ui/brand-icon';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { item } from '../components/ui/item';
import { usePullRequests, useRefreshPullRequests, useRepos } from '../lib/queries';
import { useStored } from '../lib/remember';
import { ascending } from '../lib/sort';

type Pull = { repoId: string; number: number };

/** Hosts whose pull requests open in the console; GitLab's are listed and open on GitLab. */
const OPENS_HERE: GitHost[] = [GitHost.Github, GitHost.Bitbucket];

const BRAND = {
  [GitHost.Github]: 'github',
  [GitHost.Gitlab]: 'gitlab',
  [GitHost.Bitbucket]: 'bitbucket',
} as const;

type Project = { key: string; host: GitHost; slug: string; repoId: string | null; prs: PullRequest[] };

/** Pull requests by repository, A→Z by `slug`. */
function byProject(prs: PullRequest[]): Project[] {
  const out = new Map<string, Project>();
  for (const pr of prs) {
    const key = `${pr.host}:${pr.slug.toLowerCase()}`;
    const project = out.get(key) ?? { key, host: pr.host, slug: pr.slug, repoId: pr.repo_id, prs: [] };
    project.prs.push(pr);
    out.set(key, project);
  }
  return ascending([...out.values()], (project) => project.slug);
}

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

const FOLDED_KEY = 'ops-console-pr-folded';

/** Projects the operator folded, kept across reloads. */
function useFolded() {
  const [folded, setFolded] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]');
      return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
    } catch {
      return [];
    }
  });
  const save = (next: string[]) => {
    setFolded(next);
    localStorage.setItem(FOLDED_KEY, JSON.stringify(next));
  };
  return {
    folded,
    toggle: (key: string) => save(folded.includes(key) ? folded.filter((other) => other !== key) : [...folded, key]),
    set: save,
  };
}

const REVIEWS: Record<PrReviewState, string> = {
  [PrReviewState.None]: '',
  [PrReviewState.Approved]: 'approved',
  [PrReviewState.ChangesRequested]: 'changes requested',
};

export function PullRequestsPane({ selected, onSelect }: { selected: Pull | null; onSelect: (pull: Pull) => void }) {
  const [mine, setMine] = useStored('workspace.pr-mine', z.boolean(), true);
  const [q, setQ] = useStored('workspace.pr-search', z.string(), '');
  const pulls = usePullRequests({ mine, q });
  const refresh = useRefreshPullRequests();
  const repos = useRepos();
  const repoName = (id: string) => repos.data?.data.find((repo) => repo.id === id)?.name ?? '';
  const fold = useFolded();
  const projects = pulls.data ? byProject(pulls.data.data) : [];
  // A search shows every match.
  const isFolded = (key: string) => q.trim() === '' && fold.folded.includes(key);
  const allFolded = projects.length > 0 && projects.every((project) => isFolded(project.key));

  return (
    <div>
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
            title="Read the Git hosts again now. The list also refreshes on its own."
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
            placeholder="Search title, author, branch"
            onChange={(event) => setQ(event.target.value)}
            className="w-full rounded-md border border-divider bg-card py-1.5 pr-2.5 pl-7.5 text-xs text-text outline-none focus:border-accent-400 focus:shadow-[0_0_0_3px_var(--color-accent-100)]"
          />
        </div>
        {pulls.data && pulls.data.data.length > 0 && (
          <div className="flex items-center gap-2 px-0.5 text-xs text-neutral-700">
            <span>
              <strong className="font-semibold text-text">{pulls.data.data.length}</strong>{' '}
              {pulls.data.data.length === 1 ? 'pull request' : 'pull requests'} in{' '}
              <strong className="font-semibold text-text">{projects.length}</strong>{' '}
              {projects.length === 1 ? 'project' : 'projects'}
            </span>
            {projects.length > 1 && (
              <button
                type="button"
                onClick={() => fold.set(allFolded ? [] : projects.map((project) => project.key))}
                className="ml-auto flex cursor-pointer items-center gap-1 rounded border-0 bg-transparent px-1 py-0.5 text-xs text-neutral-700 hover:bg-neutral-200 hover:text-text"
              >
                <span aria-hidden className={`text-xs transition-transform ${allFolded ? '' : 'rotate-90'}`}>
                  ▶
                </span>
                {allFolded ? 'Expand all' : 'Collapse all'}
              </button>
            )}
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
          {pulls.data.data.length === 0 ? (
            <Empty>
              {q.trim() !== ''
                ? `No ${mine ? 'pull requests of yours' : 'pull requests'} match “${q.trim()}”.`
                : mine
                  ? 'No open pull requests of yours.'
                  : 'No open pull requests.'}
            </Empty>
          ) : (
            <div className="flex flex-col gap-1 px-2 pt-2 pb-3">
              {projects.map((project) => (
                <section key={project.key} aria-label={project.slug}>
                  <h3 className="m-0">
                    <button
                      type="button"
                      aria-expanded={!isFolded(project.key)}
                      onClick={() => fold.toggle(project.key)}
                      className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-xs font-semibold text-text hover:bg-neutral-200"
                    >
                      <span
                        aria-hidden
                        className={`flex-none text-xs text-neutral-600 transition-transform ${isFolded(project.key) ? '' : 'rotate-90'}`}
                      >
                        ▶
                      </span>
                      {project.host !== GitHost.Local && <BrandIcon brand={BRAND[project.host]} size="xs" />}
                      <span className="min-w-0 truncate font-mono">{project.slug}</span>
                      {project.repoId ? (
                        <span
                          title="Imported as a Repo: its pull requests open here in the console"
                          className="flex-none rounded-full bg-accent-100 px-1.75 text-xs font-semibold text-accent-900"
                        >
                          local · {repoName(project.repoId)}
                        </span>
                      ) : (
                        <span
                          title="Not imported as a Repo: its pull requests open on the Git host. Import it in Repos to review them here."
                          className="flex-none rounded-full bg-neutral-200 px-1.75 text-xs font-normal text-neutral-700"
                        >
                          not imported
                        </span>
                      )}
                      <span className="ml-auto flex-none font-mono text-xs font-normal text-neutral-700">
                        {project.prs.length}
                      </span>
                    </button>
                  </h3>
                  {!isFolded(project.key) && (
                    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                      {project.prs.map((pr) => {
                        const repoId = pr.repo_id;
                        const here = repoId !== null && OPENS_HERE.includes(pr.host);
                        const active = here && selected?.repoId === repoId && selected.number === pr.number;
                        const body = (
                          <>
                            <span className="flex w-full items-center gap-1.5 font-semibold">
                              <span className="min-w-0 truncate">
                                #{pr.number} {pr.title}
                              </span>
                              {!here && (
                                <span aria-hidden className="ml-auto flex-none text-xs font-normal text-neutral-600">
                                  ↗
                                </span>
                              )}
                            </span>
                            <span className="flex flex-wrap gap-x-2 font-mono text-xs text-neutral-700">
                              <span>{pr.author}</span>
                              <span className="truncate">{pr.branch}</span>
                              {pr.by_agent && <span title="A Session in the console worked on this branch">agent</span>}
                              {CHECKS[pr.checks] && <span title={CHECKS_TIP[pr.checks]}>{CHECKS[pr.checks]}</span>}
                              {pr.approved_by.length > 0 ? (
                                <span className="text-ok">✓ approved by {pr.approved_by.join(', ')}</span>
                              ) : (
                                REVIEWS[pr.review_state] && <span>{REVIEWS[pr.review_state]}</span>
                              )}
                              {pr.comment_count > 0 && <span>{pr.comment_count} comments</span>}
                            </span>
                          </>
                        );
                        const look = `flex w-full flex-col gap-0.5 px-3 py-2 text-[13px] no-underline ${item(active)}`;
                        return (
                          <li key={`${project.key}#${pr.number}`}>
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
                      })}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
