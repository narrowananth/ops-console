import type { Repo, Session } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { useBranches, useCreateRepoSession, useRepoSessions, useRepos } from '../lib/queries';

function NewSession({ repo, onCreated }: { repo: Repo; onCreated: (id: string) => void }) {
  const branches = useBranches(repo.id);
  const create = useCreateRepoSession();
  const [branch, setBranch] = useState<string | null>(null);
  const chosen = branch ?? branches.data?.find((b) => b.current)?.name ?? branches.data?.[0]?.name ?? '';
  return (
    <div className="flex flex-col gap-1.5 px-5 pb-3">
      <div className="flex gap-1.5">
        <select
          aria-label={`Branch for a new Session in ${repo.name}`}
          value={chosen}
          onChange={(event) => setBranch(event.target.value)}
          className="min-w-0 flex-1 border-[1.5px] border-text bg-bg px-1.5 py-1 font-mono text-xs text-text"
        >
          {branches.data?.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
              {b.has_open_pr ? ' · open PR' : ''}
            </option>
          ))}
        </select>
        <Button
          variant="primary"
          className="px-2.5 py-1 text-xs"
          disabled={chosen === '' || create.isPending}
          onClick={() => create.mutate({ repo_id: repo.id, branch: chosen }, { onSuccess: (s) => onCreated(s.id) })}
        >
          Start
        </Button>
      </div>
      {create.isError && (
        <div role="alert" className="text-xs text-accent-700">
          {create.error.message}
        </div>
      )}
    </div>
  );
}

function SessionRow({ session, selected, onSelect }: { session: Session; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        aria-current={selected}
        onClick={onSelect}
        className={`flex w-full cursor-pointer flex-col gap-0.5 border-0 border-l-3 px-5 py-2 text-left text-[13px] text-text hover:bg-neutral-200 ${selected ? 'border-l-accent bg-neutral-200' : 'border-l-transparent bg-transparent'}`}
      >
        <span className="truncate font-bold">{session.title}</span>
        <span className="flex items-center gap-2 font-mono text-[11px] text-neutral-700">
          <span>{session.branch}</span>
          <span className={session.state === 'idle' ? '' : 'text-accent-700'}>{session.state.replace('_', ' ')}</span>
        </span>
      </button>
    </li>
  );
}

export function SessionsPane({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const repos = useRepos();
  const sessions = useRepoSessions();
  if (repos.isPending || sessions.isPending) return <Empty>Reading Sessions…</Empty>;
  if (repos.isError || sessions.isError) return <Empty>Could not read Sessions.</Empty>;
  if (repos.data.data.length === 0) return <Empty>Import a Repo in Settings › Repos</Empty>;
  return (
    <div>
      {repos.data.data.map((repo) => {
        const mine = sessions.data.filter((session) => session.repo_id === repo.id);
        return (
          <section key={repo.id} aria-label={repo.name}>
            <div className="flex items-baseline gap-2 px-5 pt-3 pb-1.5">
              <strong className="font-mono text-[13px]">{repo.name}</strong>
              <span className="font-mono text-[11px] text-neutral-700">{repo.branch}</span>
            </div>
            <ul className="m-0 list-none p-0">
              {mine.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  selected={selected === session.id}
                  onSelect={() => onSelect(session.id)}
                />
              ))}
            </ul>
            {!repo.missing && <NewSession repo={repo} onCreated={onSelect} />}
          </section>
        );
      })}
    </div>
  );
}
