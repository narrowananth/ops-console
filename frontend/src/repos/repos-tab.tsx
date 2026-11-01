import { RemovedRepoSessions, type Repo } from '@ops-console/shared';
import { useState } from 'react';
import { RepoIcon } from '../components/ui/brand-icon';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { useImportRepo, usePickFolder, useRemoveRepo, useRepos } from '../lib/queries';
import { ascending } from '../lib/sort';

function RepoRow({ repo }: { repo: Repo }) {
  const remove = useRemoveRepo();
  const [confirming, setConfirming] = useState(false);
  return (
    <li aria-label={repo.name} className="flex items-center gap-3.5 border-b border-line px-5 py-3">
      <RepoIcon host={repo.host} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <strong className="font-mono text-[13px]">{repo.name}</strong>
          <span className="rounded-full bg-neutral-200 px-2 py-px text-[10px] text-neutral-700">{repo.host}</span>
          {repo.dirty && <span className="text-[10px] text-accent-700">uncommitted changes</span>}
        </div>
        <div className="truncate font-mono text-[11px] text-neutral-700">{repo.path}</div>
        <div className={`text-[11px] ${repo.missing ? 'text-accent-700' : 'text-neutral-700'}`}>
          {repo.missing ? 'This folder is gone from the machine.' : `branch ${repo.branch ?? '?'}`}
        </div>
        {remove.error && (
          <div role="alert" className="text-xs text-accent-700">
            {remove.error.message}
          </div>
        )}
      </div>
      {confirming && repo.session_count > 0 ? (
        <div className="flex max-w-80 flex-col items-end gap-1.5 text-xs">
          <span className="text-right">
            Remove from the list? It has {repo.session_count} {repo.session_count === 1 ? 'Session' : 'Sessions'}. Kept
            ones come back when you import this folder again.
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="primary"
              className="px-2.5 py-1 text-xs"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: repo.id, sessions: RemovedRepoSessions.Keep })}
            >
              Keep Sessions
            </Button>
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: repo.id, sessions: RemovedRepoSessions.Delete })}
            >
              Delete Sessions
            </Button>
            <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : confirming ? (
        <div className="flex items-center gap-1.5 text-xs">
          <span>Remove from the list?</span>
          <Button
            variant="primary"
            className="px-2.5 py-1 text-xs"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ id: repo.id })}
          >
            Remove
          </Button>
          <Button className="px-2.5 py-1 text-xs" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button className="px-2.5 py-1 text-xs" onClick={() => setConfirming(true)}>
          Remove
        </Button>
      )}
    </li>
  );
}

export function ReposTab() {
  const repos = useRepos();
  const importRepo = useImportRepo();
  const pick = usePickFolder();
  const browse = () =>
    pick.mutate(undefined, {
      onSuccess: (chosen) => {
        if (chosen !== null) importRepo.mutate(chosen);
      },
    });

  return (
    <div>
      <div className="flex flex-col gap-2 border-b border-line px-5 py-4">
        <div className="text-xs font-extrabold">Import a local repo</div>
        <button
          type="button"
          disabled={pick.isPending || importRepo.isPending}
          onClick={browse}
          className="flex cursor-pointer flex-col items-start gap-0.5 border border-divider bg-card px-3 py-2.5 text-left text-text hover:bg-neutral-200 disabled:cursor-wait"
        >
          <span className="text-[13px] font-extrabold">Local folder</span>
          <span className="text-[11px] text-neutral-700">
            {pick.isPending ? 'Waiting for the folder dialog…' : 'Browse a folder on disk'}
          </span>
        </button>
        {pick.isError && (
          <div role="alert" className="text-xs text-accent-700">
            {pick.error.message}
          </div>
        )}
        {importRepo.isSuccess && (
          <div role="status" className="text-xs">
            Imported {importRepo.data.data.name} · branch {importRepo.data.data.branch}
          </div>
        )}
        {importRepo.isError && (
          <div role="alert" className="text-xs text-accent-700">
            {importRepo.error.message}
          </div>
        )}
      </div>
      {repos.isPending ? (
        <Empty>Reading repos…</Empty>
      ) : repos.isError ? (
        <Empty>Could not read repos: {repos.error.message}</Empty>
      ) : (
        <>
          <div className="px-5 py-3 text-[11px] tracking-[0.08em] text-neutral-700 uppercase">
            Imported repos · {repos.data.data.length}
          </div>
          {repos.data.data.length === 0 ? (
            <Empty>No repos yet. Import one above.</Empty>
          ) : (
            <ul className="m-0 list-none p-0">
              {ascending(repos.data.data, (repo) => repo.name).map((repo) => (
                <RepoRow key={repo.id} repo={repo} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
