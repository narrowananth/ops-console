import { type Repo, type Session, SessionState } from '@ops-console/shared';
import { useState } from 'react';
import { RepoIcon } from '../components/ui/brand-icon';
import { Button } from '../components/ui/button';
import { Dropdown } from '../components/ui/dropdown';
import { Empty } from '../components/ui/empty';
import { item } from '../components/ui/item';
import { useBranches, useCreateRepoSession, useRepoSessions, useRepos } from '../lib/queries';

/** An open Repo lists this many of its Sessions, most recently active first, before "Show N more". */
const SHOWN = 3;
const FOLDED_KEY = 'ops-console-workspace-folded';

function readFolded(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

const isRunning = (session: Session) =>
  session.state === SessionState.Working || session.state === SessionState.WaitingApproval;

function NewSession({ repo, onCreated }: { repo: Repo; onCreated: (id: string) => void }) {
  const branches = useBranches(repo.id);
  const create = useCreateRepoSession();
  const [branch, setBranch] = useState<string | null>(null);
  const chosen = branch ?? branches.data?.find((b) => b.current)?.name ?? branches.data?.[0]?.name ?? '';
  return (
    <div className="flex flex-col gap-1.5 px-2 pt-1 pb-2">
      <div className="flex gap-1.5">
        <Dropdown
          label={`Branch for a new Session in ${repo.name}`}
          title={chosen}
          value={chosen}
          options={(branches.data ?? []).map((b) => ({
            value: b.name,
            label: b.name,
            description: [b.current && 'checked out', b.has_open_pr && 'open PR'].filter(Boolean).join(' · '),
          }))}
          onChange={setBranch}
          align="left"
          heading="Start on branch"
          className="min-w-0 flex-1 font-mono"
          listClassName="w-max max-w-md"
        />
        <Button
          variant="primary"
          className="px-3.5 py-1.5 text-xs"
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

/** One line: title and state. The branch shows under it only when it differs from the Repo's. */
function SessionRow({
  session,
  repoBranch,
  selected,
  onSelect,
}: {
  session: Session;
  repoBranch: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={selected}
        title={session.branch ? `${session.title} · ${session.branch}` : session.title}
        onClick={onSelect}
        className={`flex w-full flex-col py-2 pr-3 pl-7 text-[13px] ${item(selected)}`}
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-bold">{session.title}</span>
          <span
            className={`flex-none rounded-full px-1.75 font-mono text-[10px] ${session.state === SessionState.Idle ? 'bg-neutral-200 text-neutral-700' : 'bg-accent-100 text-accent-700'}`}
          >
            {session.state.replace('_', ' ')}
          </span>
        </span>
        {session.branch && session.branch !== repoBranch && (
          <span className="truncate font-mono text-[11px] text-neutral-700">{session.branch}</span>
        )}
      </button>
    </li>
  );
}

function RepoGroup({
  repo,
  sessions,
  folded,
  onFold,
  selected,
  onSelect,
}: {
  repo: Repo;
  sessions: Session[];
  folded: boolean;
  onFold: () => void;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [all, setAll] = useState(false);
  const [starting, setStarting] = useState(sessions.length === 0);
  // Past the first few, a running or selected Session still shows: it is the one the operator is after.
  const shown = all
    ? sessions
    : sessions.filter((session, index) => index < SHOWN || isRunning(session) || session.id === selected);
  const hidden = sessions.length - shown.length;
  const running = sessions.filter(isRunning).length;
  return (
    <section aria-label={repo.name} className="px-2 pb-1.5">
      <div className="flex items-center gap-1 rounded-md pr-1.5 hover:bg-neutral-200">
        <button
          type="button"
          aria-expanded={!folded}
          onClick={onFold}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent py-2 pl-2 text-left text-text"
        >
          <span aria-hidden className="w-3 flex-none text-[10px] text-neutral-700">
            {folded ? '▸' : '▾'}
          </span>
          <RepoIcon host={repo.host} size="xs" />
          <strong className="flex-none font-mono text-[13px]">{repo.name}</strong>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-700">{repo.branch}</span>
          {running > 0 && <span className="flex-none font-mono text-[11px] text-accent-700">{running} running</span>}
          <span className="flex-none font-mono text-[11px] text-neutral-700">{sessions.length}</span>
        </button>
        {!repo.missing && (
          <button
            type="button"
            aria-label={`New Session in ${repo.name}`}
            title="New Session"
            aria-pressed={starting && !folded}
            onClick={() => {
              if (folded) onFold();
              setStarting(folded || !starting);
            }}
            className="flex size-6.5 flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-base font-extrabold text-accent hover:bg-accent-100"
          >
            +
          </button>
        )}
      </div>
      {!folded && (
        <>
          {starting && !repo.missing && (
            <NewSession
              repo={repo}
              onCreated={(id) => {
                setStarting(false);
                onSelect(id);
              }}
            />
          )}
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {shown.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                repoBranch={repo.branch}
                selected={selected === session.id}
                onSelect={() => onSelect(session.id)}
              />
            ))}
          </ul>
          {(hidden > 0 || all) && sessions.length > SHOWN && (
            <button
              type="button"
              onClick={() => setAll(!all)}
              className="mt-0.5 cursor-pointer rounded-sm border-0 bg-transparent py-1 pl-7 text-xs text-accent-700 hover:underline"
            >
              {all ? 'Show fewer' : `Show ${hidden} more`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function SessionsPane({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const repos = useRepos();
  const sessions = useRepoSessions();
  // Folded Repos are remembered in this browser.
  const [folded, setFolded] = useState(readFolded);
  if (repos.isPending || sessions.isPending) return <Empty>Reading Sessions…</Empty>;
  if (repos.isError || sessions.isError) return <Empty>Could not read Sessions.</Empty>;
  if (repos.data.data.length === 0) return <Empty>Import a Repo in Repos</Empty>;
  const fold = (id: string) => {
    const next = folded.includes(id) ? folded.filter((other) => other !== id) : [...folded, id];
    localStorage.setItem(FOLDED_KEY, JSON.stringify(next));
    setFolded(next);
  };
  return (
    <div className="pb-3">
      {repos.data.data.map((repo) => (
        <RepoGroup
          key={repo.id}
          repo={repo}
          sessions={sessions.data.filter((session) => session.repo_id === repo.id)}
          folded={folded.includes(repo.id)}
          onFold={() => fold(repo.id)}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
