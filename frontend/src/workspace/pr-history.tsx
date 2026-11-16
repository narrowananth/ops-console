import { PrMergeState, type PullRequestDetail } from '@ops-console/shared';
import { ago } from '../monitor/scan-scope';
import { Avatar } from './pr-meta';

/** The branch's commits, newest first, each linking to its page on the host. */
export function PrCommits({ pr }: { pr: PullRequestDetail }) {
  const newest = [...pr.commits].reverse();
  if (newest.length === 0) return <p className="m-0 text-[13px] text-neutral-700">The Git host lists no commits.</p>;
  return (
    <section aria-label="Commits" className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
      <div className="border-b border-divider bg-surface px-4 py-2 text-xs text-neutral-700">
        {newest.length} {newest.length === 1 ? 'commit' : 'commits'} on {pr.branch} that {pr.base_branch} lacks
      </div>
      <ul className="m-0 list-none p-0">
        {newest.map((commit) => (
          <li
            key={commit.sha}
            className="flex items-center gap-3 border-t border-divider px-4 py-2.5 first:border-t-0 hover:bg-neutral-100"
          >
            <Avatar name={commit.author} size="sm" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium" title={commit.message}>
                {commit.message}
              </span>
              <span className="text-xs text-neutral-700">
                {commit.author} ·{' '}
                <span title={new Date(commit.created_at).toLocaleString()}>{ago(commit.created_at)}</span>
              </span>
            </span>
            {commit.url ? (
              <a
                href={commit.url}
                target="_blank"
                rel="noreferrer"
                title={`Open ${commit.sha} on ${pr.host}`}
                className="flex-none rounded-sm bg-neutral-200 px-1.5 py-0.5 font-mono text-xs text-text no-underline hover:bg-neutral-300"
              >
                {commit.sha.slice(0, 7)}
              </a>
            ) : (
              <span className="flex-none rounded-sm bg-neutral-200 px-1.5 py-0.5 font-mono text-xs">
                {commit.sha.slice(0, 7)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Which files conflict with the base and how to resolve them; shown only when some do. */
export function ConflictBanner({ pr, onOpenFile }: { pr: PullRequestDetail; onOpenFile: (name: string) => void }) {
  const check = pr.conflicts;
  if (check?.state !== PrMergeState.Conflict) return null;
  const inDiff = new Set(pr.files.map((file) => file.name));
  return (
    <section
      aria-label="Merge conflicts"
      className="overflow-hidden rounded-xl border border-accent-200 bg-card shadow-sm"
    >
      <div className="flex items-start gap-2.5 bg-accent-100 px-4 py-3">
        <span aria-hidden className="mt-px text-accent-700">
          ⚠
        </span>
        <div className="flex flex-col gap-0.5">
          <strong className="text-[13px] text-accent-900">This pull request has conflicts</strong>
          <span className="text-xs text-accent-800">
            {pr.branch} and {pr.base_branch} changed the same lines in {check.files.length}{' '}
            {check.files.length === 1 ? 'file' : 'files'}. It cannot merge until they are resolved on {pr.branch}.
          </span>
        </div>
      </div>
      <ul className="m-0 list-none border-t border-accent-200 p-0">
        {check.files.map((name) => (
          <li key={name} className="border-t border-divider first:border-t-0">
            {inDiff.has(name) ? (
              <button
                type="button"
                title="Show this file in Files changed"
                onClick={() => onOpenFile(name)}
                className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-4 py-1.5 text-left font-mono text-xs text-text hover:bg-neutral-100"
              >
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className="flex-none font-body text-accent-700">conflict</span>
              </button>
            ) : (
              <span className="flex items-center gap-2 px-4 py-1.5 font-mono text-xs">
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className="flex-none font-body text-accent-700">conflict</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      <details className="border-t border-divider px-4 py-2 text-xs">
        <summary className="cursor-pointer text-neutral-800">Resolve on your machine</summary>
        <pre className="m-0 mt-2 overflow-x-auto rounded-md bg-surface px-3 py-2 font-mono text-xs leading-relaxed">
          {`git fetch origin\ngit checkout ${pr.branch}\ngit merge origin/${pr.base_branch}\n# fix the conflicted files, then\ngit commit\ngit push`}
        </pre>
      </details>
    </section>
  );
}
