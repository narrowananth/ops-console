import type { Repo } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { useImportRepo, useRemoveRepo, useRepos } from '../lib/queries';

function RepoRow({ repo }: { repo: Repo }) {
  const remove = useRemoveRepo();
  const [confirming, setConfirming] = useState(false);
  return (
    <li aria-label={repo.name} className="flex items-center gap-3 border-b border-neutral-300 px-5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <strong className="font-mono text-[13px]">{repo.name}</strong>
          <span className="border border-divider px-1.5 py-px text-[10px] text-neutral-700">{repo.host}</span>
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
      {confirming ? (
        <div className="flex items-center gap-1.5 text-xs">
          <span>Remove from the list?</span>
          <Button
            variant="primary"
            className="px-2.5 py-1 text-xs"
            disabled={remove.isPending}
            onClick={() => remove.mutate(repo.id)}
          >
            Remove
          </Button>
          <Button className="px-2.5 py-1 text-xs" onClick={() => setConfirming(false)}>
            Keep
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
  const [path, setPath] = useState('');
  const submit = () => {
    if (path.trim() === '') return;
    importRepo.mutate(path, { onSuccess: () => setPath('') });
  };

  return (
    <div>
      <div className="flex flex-col gap-2 border-b-2 border-divider px-5 py-4">
        <label htmlFor="repo-path" className="text-xs font-extrabold">
          Import a local repo
        </label>
        <div className="flex gap-2">
          <input
            id="repo-path"
            value={path}
            placeholder="~/code/orders-api"
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
            className="flex-1 border-[1.5px] border-text bg-bg px-2 py-1.5 font-mono text-[13px] text-text"
          />
          <Button variant="primary" disabled={importRepo.isPending} onClick={submit}>
            Import
          </Button>
        </div>
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
              {repos.data.data.map((repo) => (
                <RepoRow key={repo.id} repo={repo} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
