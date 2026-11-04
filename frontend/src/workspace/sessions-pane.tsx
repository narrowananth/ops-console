import { type Repo, type Session, SessionKind, SessionState } from '@ops-console/shared';
import { useState } from 'react';
import { z } from 'zod';
import { StopIcon } from '../agents/stop-run';
import { RepoIcon } from '../components/ui/brand-icon';
import { Button } from '../components/ui/button';
import { Dropdown } from '../components/ui/dropdown';
import { Empty } from '../components/ui/empty';
import { item } from '../components/ui/item';
import {
  useBranches,
  useCreateAnonymousSession,
  useCreateRepoSession,
  useRepoSessions,
  useRepos,
  useStopSession,
} from '../lib/queries';
import { useStored } from '../lib/remember';
import { ascending } from '../lib/sort';

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

/** What each Session state means, on its badge. */
export const SESSION_STATE_TIP: Record<SessionState, string> = {
  [SessionState.Idle]: 'Idle: waiting for your next message',
  [SessionState.Working]: 'Working: the agent is running',
  [SessionState.WaitingInput]: 'Waiting on you: the agent asked a question. Your next message answers it.',
  [SessionState.WaitingApproval]: 'Waiting on you: the agent needs your Approval to go on',
  [SessionState.Failed]: 'Failed: the last run stopped with an error. Send a message to go on.',
};

const isRunning = (session: Session) =>
  session.state === SessionState.Working || session.state === SessionState.WaitingApproval;

/** A question waiting on the operator still holds the run, so it can be stopped too. */
const isBusy = (session: Session) => isRunning(session) || session.state === SessionState.WaitingInput;

/** Stop on a busy row, over its state on hover or focus; a button may not sit inside the row's button. */
function RowStop({ session }: { session: Session }) {
  const stop = useStopSession(session.id);
  return (
    <button
      type="button"
      aria-label={`Stop ${session.title}`}
      title={stop.isError ? stop.error.message : 'Stop the agent where it is. The conversation stays.'}
      disabled={stop.isPending}
      onClick={() => stop.mutate()}
      className="absolute top-1.5 right-2 flex cursor-pointer items-center gap-1 rounded-full border border-line bg-card px-2 py-0.5 font-mono text-xs text-accent-700 opacity-0 shadow-sm group-hover:opacity-100 focus-visible:opacity-100 hover:border-accent-400 disabled:cursor-wait"
    >
      <StopIcon />
      stop
    </button>
  );
}

function NewSession({ repo, onCreated }: { repo: Repo; onCreated: (id: string) => void }) {
  const branches = useBranches(repo.id);
  const create = useCreateRepoSession();
  const [branch, setBranch] = useStored(`workspace.new-branch.${repo.id}`, z.string().nullable(), null);
  const chosen = branch ?? branches.data?.find((b) => b.current)?.name ?? branches.data?.[0]?.name ?? '';
  return (
    <div className="flex flex-col gap-1.5 px-2 pt-1 pb-2">
      <div className="flex gap-1.5">
        <Dropdown
          label={`Branch for a new Session in ${repo.name}`}
          title={`The new Session works on ${chosen || 'this branch'} in ${repo.name}`}
          value={chosen}
          options={ascending(branches.data ?? [], (b) => b.name).map((b) => ({
            value: b.name,
            label: b.name,
            description: [b.current && 'checked out', b.has_open_pr && 'open PR'].filter(Boolean).join(' · '),
          }))}
          onChange={setBranch}
          align="left"
          heading="Start on branch"
          searchable
          className="min-w-0 flex-1 font-mono"
          listClassName="w-max max-w-md"
        />
        <Button
          variant="primary"
          className="px-3.5 py-1.5 text-xs"
          disabled={chosen === '' || create.isPending}
          title={chosen === '' ? 'Pick a branch first' : `Start a Session on ${chosen}`}
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
    <li className="group relative">
      <button
        type="button"
        aria-current={selected}
        title={session.branch ? `${session.title} · ${session.branch}` : session.title}
        onClick={onSelect}
        className={`flex w-full flex-col py-2 pr-3 pl-7 text-[13px] ${item(selected)}`}
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-semibold">{session.title}</span>
          <span
            title={SESSION_STATE_TIP[session.state]}
            className={`flex-none rounded-full px-1.75 font-mono text-xs ${session.state === SessionState.Idle ? 'bg-neutral-200 text-neutral-700' : 'bg-accent-100 text-accent-700'}`}
          >
            {session.state.replace('_', ' ')}
          </span>
        </span>
        {session.branch && session.branch !== repoBranch && (
          <span className="truncate font-mono text-xs text-neutral-700">{session.branch}</span>
        )}
      </button>
      {isBusy(session) && <RowStop session={session} />}
    </li>
  );
}

function RepoGroup({
  repo,
  sessions,
  searching,
  folded,
  onFold,
  selected,
  onSelect,
}: {
  repo: Repo;
  sessions: Session[];
  /** A search is on: every matching Session shows, with no "Show N more". */
  searching: boolean;
  folded: boolean;
  onFold: () => void;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [all, setAll] = useStored(`workspace.sessions-all.${repo.id}`, z.boolean(), false);
  const [starting, setStarting] = useStored(`workspace.starting.${repo.id}`, z.boolean(), sessions.length === 0);
  // Past the first few, a running or selected Session still shows: it is the one the operator is after.
  const shown =
    all || searching
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
          <span aria-hidden className="w-3 flex-none text-xs text-neutral-700">
            {folded ? '▸' : '▾'}
          </span>
          <RepoIcon host={repo.host} size="xs" />
          <strong className="flex-none font-mono text-[13px]">{repo.name}</strong>
          <span
            title="The branch checked out in this Repo's folder now"
            className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-700"
          >
            {repo.branch}
          </span>
          {running > 0 && <span className="flex-none font-mono text-xs text-accent-700">{running} running</span>}
          <span title="Sessions in this Repo" className="flex-none font-mono text-xs text-neutral-700">
            {sessions.length}
          </span>
        </button>
        {!repo.missing && (
          <button
            type="button"
            aria-label={`New Session in ${repo.name}`}
            title="New Session: pick a branch and talk to the agent in this Repo"
            aria-pressed={starting && !folded}
            onClick={() => {
              if (folded) onFold();
              setStarting(folded || !starting);
            }}
            className="flex size-6.5 flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-base font-semibold text-accent hover:bg-accent-100"
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
          {!searching && (hidden > 0 || all) && sessions.length > SHOWN && (
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

/** Sessions with no imported Repo: each works in its own folder, and may clone a repo into it. */
function AnonymousGroup({
  sessions,
  searching,
  selected,
  onSelect,
}: {
  sessions: Session[];
  searching: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const create = useCreateAnonymousSession();
  const [all, setAll] = useStored('workspace.sessions-all.anonymous', z.boolean(), false);
  const shown =
    all || searching
      ? sessions
      : sessions.filter((session, index) => index < SHOWN || isRunning(session) || session.id === selected);
  const hidden = sessions.length - shown.length;
  return (
    <section aria-label="No Repo" className="px-2 pb-1.5">
      <div className="flex items-center gap-1 rounded-md pr-1.5 hover:bg-neutral-200">
        <span className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2">
          <span aria-hidden className="w-3 flex-none" />
          <span
            aria-hidden
            className="inline-flex size-4.5 flex-none items-center justify-center rounded-[5px] border border-dashed border-neutral-500 text-xs text-neutral-700"
          >
            ∅
          </span>
          <strong className="flex-none text-[13px]">No Repo</strong>
          <span
            title="Anonymous Sessions work in a folder of their own, not in an imported Repo. The agent may clone a repository there."
            className="min-w-0 flex-1 truncate text-xs text-neutral-700"
          >
            anonymous
          </span>
          <span title="Anonymous Sessions" className="flex-none font-mono text-xs text-neutral-700">
            {sessions.length}
          </span>
        </span>
        <button
          type="button"
          aria-label="New anonymous Session"
          title="New anonymous Session: no Repo, a folder of its own. Ask the agent to clone a repository or anything else."
          disabled={create.isPending}
          onClick={() => create.mutate({}, { onSuccess: (session) => onSelect(session.id) })}
          className="flex size-6.5 flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-base font-semibold text-accent hover:bg-accent-100"
        >
          +
        </button>
      </div>
      {create.isError && (
        <div role="alert" className="px-2 pb-1 text-xs text-accent-700">
          {create.error.message}
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {shown.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            repoBranch={null}
            selected={selected === session.id}
            onSelect={() => onSelect(session.id)}
          />
        ))}
      </ul>
      {!searching && (hidden > 0 || all) && sessions.length > SHOWN && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="mt-0.5 cursor-pointer rounded-sm border-0 bg-transparent py-1 pl-7 text-xs text-accent-700 hover:underline"
        >
          {all ? 'Show fewer' : `Show ${hidden} more`}
        </button>
      )}
    </section>
  );
}

/** Whether a search matches: case-insensitive, anywhere in the text. An empty search matches everything. */
const matcher =
  (q: string) =>
  (...texts: (string | null)[]) => {
    const needle = q.trim().toLowerCase();
    return needle === '' || texts.some((text) => text?.toLowerCase().includes(needle));
  };

/**
 * A Repo whose name or checked-out branch matches keeps all its Sessions; any other Repo keeps only the Sessions whose
 * title or branch matches, and drops out when none do.
 */
function searchGroup(sessions: Session[], groupHit: boolean, matches: ReturnType<typeof matcher>) {
  return groupHit ? sessions : sessions.filter((session) => matches(session.title, session.branch));
}

export function SessionsPane({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const repos = useRepos();
  const sessions = useRepoSessions();
  const [q, setQ] = useStored('workspace.session-search', z.string(), '');
  // Folded Repos are remembered in this browser.
  const [folded, setFolded] = useState(readFolded);
  if (repos.isPending || sessions.isPending) return <Empty>Reading Sessions…</Empty>;
  if (repos.isError || sessions.isError) return <Empty>Could not read Sessions.</Empty>;
  const searching = q.trim() !== '';
  const matches = matcher(q);
  const saveFolded = (next: string[]) => {
    localStorage.setItem(FOLDED_KEY, JSON.stringify(next));
    setFolded(next);
  };
  const fold = (id: string) =>
    saveFolded(folded.includes(id) ? folded.filter((other) => other !== id) : [...folded, id]);
  const anonymous = searchGroup(
    sessions.data.filter((session) => session.kind === SessionKind.Anonymous),
    matches('No Repo', 'anonymous'),
    matches,
  );
  const groups = ascending(repos.data.data, (repo) => repo.name)
    .map((repo) => ({
      repo,
      sessions: searchGroup(
        sessions.data.filter((session) => session.repo_id === repo.id),
        matches(repo.name, repo.branch),
        matches,
      ),
      hit: matches(repo.name, repo.branch),
    }))
    .filter((group) => group.hit || group.sessions.length > 0);
  const showAnonymous = !searching || matches('No Repo', 'anonymous') || anonymous.length > 0;
  // A search opens every match.
  const isFolded = (id: string) => !searching && folded.includes(id);
  const allFolded = groups.length > 0 && groups.every((group) => isFolded(group.repo.id));
  return (
    <div className="pb-3">
      {repos.data.data.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-divider bg-bg px-3 pt-1 pb-2.5">
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
              aria-label="Search Sessions"
              title="Matches a Repo's name or checked-out branch, or a Session's title or branch"
              value={q}
              placeholder="Search repo, branch, Session"
              onChange={(event) => setQ(event.target.value)}
              className="w-full rounded-md border border-divider bg-card py-1.5 pr-2.5 pl-7.5 text-xs text-text outline-none focus:border-accent-400 focus:shadow-[0_0_0_3px_var(--color-accent-100)]"
            />
          </div>
          <div className="flex items-center gap-2 px-0.5 text-xs text-neutral-700">
            <span>
              <strong className="font-semibold text-text">{groups.length}</strong>{' '}
              {groups.length === 1 ? 'Repo' : 'Repos'}
              {searching && ' match'}
            </span>
            {groups.length > 1 && (
              <button
                type="button"
                disabled={searching}
                title={searching ? 'A search opens every match' : undefined}
                onClick={() => saveFolded(allFolded ? [] : groups.map((group) => group.repo.id))}
                className="ml-auto flex cursor-pointer items-center gap-1 rounded border-0 bg-transparent px-1 py-0.5 text-xs text-neutral-700 hover:bg-neutral-200 hover:text-text disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <span aria-hidden className={`text-xs transition-transform ${allFolded ? '' : 'rotate-90'}`}>
                  ▶
                </span>
                {allFolded ? 'Expand all' : 'Collapse all'}
              </button>
            )}
          </div>
        </div>
      )}
      <div className="pt-1.5">
        {showAnonymous && (
          <AnonymousGroup sessions={anonymous} searching={searching} selected={selected} onSelect={onSelect} />
        )}
        {groups.map((group) => (
          <RepoGroup
            key={group.repo.id}
            repo={group.repo}
            sessions={group.sessions}
            searching={searching}
            folded={isFolded(group.repo.id)}
            onFold={() => fold(group.repo.id)}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
        {searching && groups.length === 0 && !showAnonymous && <Empty>No Repo or Session matches “{q.trim()}”.</Empty>}
        {repos.data.data.length === 0 && (
          <p className="m-0 px-4 pt-2 pb-3 text-xs text-neutral-700">Import a Repo in Repos to work on its branches.</p>
        )}
      </div>
    </div>
  );
}
