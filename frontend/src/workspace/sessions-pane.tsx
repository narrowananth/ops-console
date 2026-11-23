import { type Repo, type Session, SessionKind, SessionState } from '@ops-console/shared';
import { type ReactNode, useState } from 'react';
import { z } from 'zod';
import { MODEL_NAME } from '../agent-runs/run-look';
import { StopIcon } from '../agents/stop-run';
import { Button } from '../components/ui/button';
import { Dropdown } from '../components/ui/dropdown';
import { useNow } from '../components/ui/elapsed';
import { Empty } from '../components/ui/empty';
import { BranchIcon, PullRequestIcon } from '../components/ui/icons';
import { item } from '../components/ui/item';
import {
  useAgentRuns,
  useBranches,
  useCreateAnonymousSession,
  useCreateRepoSession,
  useRepoSessions,
  useRepos,
  useStopSession,
} from '../lib/queries';
import { useStored } from '../lib/remember';
import { ascending } from '../lib/sort';
import { ago } from '../monitor/scan-scope';
import { FilterTabs, ListGroup, SearchField, useFolded } from './list-parts';
import { HoverCard, PULL_COLOUR, SessionCard, useSessionPulls } from './session-hover-card';

/** Idle Sessions listed before "Show N more". A search, or the open Session, lifts the limit. */
const IDLE_SHOWN = 8;
const ANY = 'any';
const NO_REPO = 'none';

/** What each Session state means, on its badge. */
export const SESSION_STATE_TIP: Record<SessionState, string> = {
  [SessionState.Idle]: 'Idle: waiting for your next message',
  [SessionState.Working]: 'Working: the agent is running',
  [SessionState.WaitingInput]: 'Waiting on you: the agent asked a question. Your next message answers it.',
  [SessionState.WaitingApproval]: 'Waiting on you: the agent needs your Approval to go on',
  [SessionState.Failed]: 'Failed: the last run stopped with an error. Send a message to go on.',
};

/** A question waiting on the operator still holds the run, so it can be stopped too. */
const isBusy = (session: Session) =>
  session.state === SessionState.Working ||
  session.state === SessionState.WaitingApproval ||
  session.state === SessionState.WaitingInput;

const NEEDS_YOU: SessionState[] = [SessionState.WaitingInput, SessionState.WaitingApproval, SessionState.Failed];
const needsYou = (session: Session) => NEEDS_YOU.includes(session.state);
const working = (session: Session) => session.state === SessionState.Working;

/** Stop on a busy row, over its time on hover or focus; a button may not sit inside the row's button. */
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

/** Branch and Start for a new Session in one Repo: a local branch, one only origin has, or a new one typed in. */
function RepoStart({ repo, onCreated }: { repo: Repo; onCreated: (id: string) => void }) {
  const branches = useBranches(repo.id);
  const create = useCreateRepoSession();
  const [branch, setBranch] = useStored(`workspace.new-branch.${repo.id}`, z.string().nullable(), null);
  // A name typed into the list that no branch has: made at the newest default branch when the Session starts.
  const [fresh, setFresh] = useState<string | null>(null);
  const known = branches.data ?? [];
  const chosen = fresh ?? branch ?? known.find((b) => b.current)?.name ?? known[0]?.name ?? '';
  const picked = known.find((b) => b.name === chosen);
  const isNew = fresh !== null && picked === undefined;
  const label = isNew ? `new branch from ${repo.default_branch}` : picked?.remote ? 'on origin' : '';
  const choose = (name: string) => {
    create.reset();
    setFresh(null);
    setBranch(name);
  };
  return (
    <>
      <div className="flex gap-1.5">
        <Dropdown
          label={`Branch for a new Session in ${repo.name}`}
          title={`The new Session works on ${chosen || 'this branch'} in ${repo.name}${label ? ` (${label})` : ''}`}
          value={chosen}
          options={[
            ...(fresh !== null && picked === undefined
              ? [{ value: fresh, label: fresh, description: 'new branch' }]
              : []),
            ...ascending(known, (b) => b.name).map((b) => ({
              value: b.name,
              label: b.name,
              description: [b.current && 'checked out', b.remote && 'on origin', b.has_open_pr && 'open PR']
                .filter(Boolean)
                .join(' · '),
            })),
          ]}
          onChange={choose}
          create={{
            label: (name) => `Create ${name}`,
            describe: `A new branch from ${repo.default_branch}`,
            onCreate: (name) => {
              create.reset();
              setFresh(name);
            },
          }}
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
          onClick={() =>
            create.mutate(
              {
                repo_id: repo.id,
                branch: chosen,
                ...(isNew ? { new_branch: true } : picked?.remote ? { from_origin: true } : {}),
              },
              { onSuccess: (s) => onCreated(s.id) },
            )
          }
        >
          Start
        </Button>
      </div>
      {create.isError && (
        <div role="alert" className="text-xs text-accent-700">
          {create.error.message}
        </div>
      )}
    </>
  );
}

/** Start with no Repo: the Session works in a folder of its own and the agent may clone a repository there. */
function AnonymousStart({ onCreated }: { onCreated: (id: string) => void }) {
  const create = useCreateAnonymousSession();
  return (
    <>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 text-xs text-neutral-700">
          A folder of its own. Ask the agent to clone a repository or anything else.
        </span>
        <Button
          variant="primary"
          className="px-3.5 py-1.5 text-xs"
          disabled={create.isPending}
          title="New anonymous Session: no Repo, a folder of its own"
          onClick={() => create.mutate({}, { onSuccess: (session) => onCreated(session.id) })}
        >
          Start
        </Button>
      </div>
      {create.isError && (
        <div role="alert" className="text-xs text-accent-700">
          {create.error.message}
        </div>
      )}
    </>
  );
}

/** The one place a Session starts: pick a Repo (or none), then a branch. */
function NewSession({
  repos,
  repoFilter,
  onCreated,
}: {
  repos: Repo[];
  repoFilter: string;
  onCreated: (id: string) => void;
}) {
  const usable = ascending(
    repos.filter((repo) => !repo.missing),
    (repo) => repo.name,
  );
  const [stored, setStored] = useStored('workspace.new-repo', z.string(), '');
  const known = (id: string) => id === NO_REPO || usable.some((repo) => repo.id === id);
  const choice = [repoFilter, stored].find((id) => id !== '' && id !== ANY && known(id)) ?? usable[0]?.id ?? NO_REPO;
  const repo = usable.find((candidate) => candidate.id === choice);
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-card p-2 shadow-sm">
      <Dropdown
        label="Repo for a new Session"
        title="Where the new Session works"
        value={choice}
        options={[
          { value: NO_REPO, label: 'No Repo', description: 'anonymous: a folder of its own' },
          ...usable.map((candidate) => ({
            value: candidate.id,
            label: candidate.name,
            description: candidate.branch ?? undefined,
          })),
        ]}
        onChange={setStored}
        align="left"
        heading="Start in"
        searchable
        className="font-mono"
        listClassName="w-max min-w-60 max-w-md"
      />
      {repo ? <RepoStart key={repo.id} repo={repo} onCreated={onCreated} /> : <AnonymousStart onCreated={onCreated} />}
    </div>
  );
}

/** The one word a row says for a Session waiting on the operator; Working and Idle say nothing, their group does. */
const STATE_WORD: Partial<Record<SessionState, string>> = {
  [SessionState.WaitingApproval]: 'approval',
  [SessionState.WaitingInput]: 'question',
  [SessionState.Failed]: 'failed',
};

const STATE_DOT: Record<SessionState, string> = {
  [SessionState.Idle]: 'bg-neutral-400',
  [SessionState.Working]: 'bg-ok',
  [SessionState.WaitingInput]: 'bg-accent',
  [SessionState.WaitingApproval]: 'bg-accent',
  [SessionState.Failed]: 'bg-accent-700',
};

/** `RepoName` as two capitals for the badge: `ops-console` is OC, `apis` is AP. */
const initials = (name: string) => {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letters = words.length > 1 ? words.map((word) => word[0]).join('') : (words[0] ?? '').slice(0, 2);
  return letters.slice(0, 2).toUpperCase();
};

/** The Repo's two capitals, or `··` for a Session with no Repo. */
function RepoBadge({ repo }: { repo: Repo | null }) {
  return (
    <span
      aria-hidden
      className={`flex size-4.5 flex-none items-center justify-center rounded-sm font-mono text-[9px] font-semibold ${repo ? 'bg-accent-100 text-accent-700' : 'bg-neutral-200 text-neutral-700'}`}
    >
      {repo ? initials(repo.name) : '··'}
    </span>
  );
}

/** Whole minutes up to an hour, then hours and minutes: `36m`, `1h 05m`. */
const minutes = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 60_000));
  return total < 60 ? `${total}m` : `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
};

/** "Working 36m": the run's time since it started, to the minute. Without a start it says "Working". */
function WorkingChip({ since }: { since: string | null }) {
  const now = useNow(since !== null, 15_000);
  return (
    <span className="flex-none rounded-sm bg-ok/15 px-1.25 text-[11px] leading-4 font-medium text-ok">
      Working{since ? ` ${minutes(now - Date.parse(since))}` : ''}
    </span>
  );
}

/** The pull request mark: its number when the console opened one, `+N` for several. Its colour is the newest one's state. */
function PullRequestChip({ session }: { session: Session }) {
  const pulls = useSessionPulls(session);
  const newest = pulls[0];
  if (!newest) return null;
  return (
    <span className="flex flex-none items-center gap-0.5">
      <span aria-hidden className={`size-3.5 [&>svg]:size-3.5 ${PULL_COLOUR[newest.state ?? 'unknown']}`}>
        <PullRequestIcon />
      </span>
      {pulls.length === 1 ? newest.number : `+${pulls.length}`}
    </span>
  );
}

/**
 * Three lines: the Repo's badge and name, with the state word and time; the title; then the branch, the pull requests
 * and the model.
 */
function SessionRow({
  session,
  repo,
  runStart,
  selected,
  onSelect,
}: {
  session: Session;
  repo: Repo | null;
  runStart: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li className="group relative">
      <HoverCard
        card={() => (
          <SessionCard
            session={session}
            repo={repo}
            stateTip={SESSION_STATE_TIP[session.state]}
            badge={<RepoBadge repo={repo} />}
          />
        )}
      >
        <button
          type="button"
          aria-current={selected}
          onClick={onSelect}
          className={`flex w-full flex-col gap-0.5 px-2.5 py-1.75 text-[13px] ${item(selected)}`}
        >
          <span className="flex items-center gap-1.5">
            <RepoBadge repo={repo} />
            <span
              className={`min-w-0 flex-1 truncate text-xs ${repo ? 'text-neutral-800' : 'text-neutral-600 italic'}`}
            >
              {repo ? repo.name : 'No Repo'}
            </span>
            {session.state === SessionState.Working && <WorkingChip since={runStart} />}
            {STATE_WORD[session.state] && (
              <span className="flex-none rounded-sm bg-accent-100 px-1.25 text-[11px] leading-4 font-medium text-accent-700">
                {STATE_WORD[session.state]}
              </span>
            )}
            <span
              className="flex-none text-[11px] text-neutral-600 tabular-nums"
              title={`Started ${new Date(session.created_at).toLocaleString()}, last active ${new Date(session.last_active_at).toLocaleString()}`}
            >
              {ago(session.last_active_at)}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className={`size-2 flex-none rounded-full ${STATE_DOT[session.state]} ${session.state === SessionState.Working ? 'animate-pulse' : ''}`}
            />
            <span className="min-w-0 flex-1 truncate font-medium">{session.title}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2 pl-4 font-mono text-[11px] text-neutral-600">
            {session.branch ? (
              <span className="flex min-w-0 flex-1 items-center gap-1">
                <span aria-hidden className="size-3.5 flex-none [&>svg]:size-3.5">
                  <BranchIcon />
                </span>
                <span className="min-w-0 truncate">{session.branch}</span>
              </span>
            ) : (
              <span className="flex-1" />
            )}
            <PullRequestChip session={session} />
            <span className="flex-none">{MODEL_NAME[session.model]}</span>
          </span>
        </button>
      </HoverCard>
      {isBusy(session) && <RowStop session={session} />}
    </li>
  );
}

/** Whether a search matches: case-insensitive, anywhere in the text. An empty search matches everything. */
const matcher =
  (q: string) =>
  (...texts: (string | null)[]) => {
    const needle = q.trim().toLowerCase();
    return needle === '' || texts.some((text) => text?.toLowerCase().includes(needle));
  };

export function SessionsPane({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const repos = useRepos();
  const sessions = useRepoSessions();
  const runs = useAgentRuns();
  const [q, setQ] = useStored('workspace.session-search', z.string(), '');
  const [state, setState] = useStored('workspace.session-state', z.enum(['all', 'needs', 'running']), 'all');
  const [repoFilter, setRepoFilter] = useStored('workspace.session-repo', z.string(), ANY);
  const [starting, setStarting] = useState(false);
  const [all, setAll] = useStored('workspace.sessions-all-idle', z.boolean(), false);
  const [isFolded, toggleFold] = useFolded('session');
  if (repos.isPending || sessions.isPending) return <Empty>Reading Sessions…</Empty>;
  if (repos.isError || sessions.isError) return <Empty>Could not read Sessions.</Empty>;

  const runStartOf = (session: Session) =>
    runs.data?.find((run) => run.session.id === session.id && run.running)?.started_at ?? null;
  const repoOf = (session: Session) => repos.data.data.find((repo) => repo.id === session.repo_id) ?? null;
  const searching = q.trim() !== '';
  const matches = matcher(q);
  const withRepo = new Set(sessions.data.map((session) => session.repo_id).filter((id) => id !== null));
  const hasAnonymous = sessions.data.some((session) => session.kind === SessionKind.Anonymous);
  const repoOptions = [
    { value: ANY, label: 'All Repos', description: `${sessions.data.length} Sessions` },
    ...(hasAnonymous ? [{ value: NO_REPO, label: 'No Repo', description: 'anonymous' }] : []),
    ...ascending(
      repos.data.data.filter((repo) => withRepo.has(repo.id)),
      (repo) => repo.name,
    ).map((repo) => ({
      value: repo.id,
      label: repo.name,
      description: `${sessions.data.filter((session) => session.repo_id === repo.id).length} Sessions`,
    })),
  ];
  const repoPicked = repoOptions.some((option) => option.value === repoFilter) ? repoFilter : ANY;

  const inRepo = sessions.data.filter((session) => {
    if (repoPicked === NO_REPO) return session.kind === SessionKind.Anonymous;
    return repoPicked === ANY || session.repo_id === repoPicked;
  });
  const found = inRepo.filter((session) => {
    const repo = repoOf(session);
    return matches(
      session.title,
      session.branch,
      repo?.name ?? 'No Repo',
      repo?.branch ?? null,
      ...session.pull_requests.map((pr) => `#${pr.number}`),
    );
  });
  const counts = { needs: found.filter(needsYou).length, running: found.filter(working).length };
  const listed = found.filter(
    (session) => state === 'all' || (state === 'needs' ? needsYou(session) : working(session)),
  );
  const needs = listed.filter(needsYou);
  const running = listed.filter(working);
  const idle = listed.filter((session) => !needsYou(session) && !working(session));
  const idleShown =
    all || searching ? idle : idle.filter((session, index) => index < IDLE_SHOWN || session.id === selected);
  const idleHidden = idle.length - idleShown.length;

  const row = (session: Session) => (
    <SessionRow
      key={session.id}
      session={session}
      repo={repoOf(session)}
      runStart={runStartOf(session)}
      selected={selected === session.id}
      onSelect={() => onSelect(session.id)}
    />
  );

  const group = (key: string, label: string, dot: string, rows: Session[], more?: ReactNode) =>
    rows.length > 0 && (
      <ListGroup label={label} count={rows.length} dot={dot} folded={isFolded(key)} onToggle={() => toggleFold(key)}>
        {(key === 'idle' ? idleShown : rows).map(row)}
        {more}
      </ListGroup>
    );

  return (
    <div className="pb-3">
      <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-divider bg-bg px-3 pt-0.5 pb-2">
        <div className="flex items-center gap-1.5">
          <SearchField
            label="Search Sessions"
            title="Matches a Session's title, branch or pull request number, or its Repo's name or checked-out branch"
            value={q}
            placeholder="Search Sessions"
            onChange={setQ}
          />
          <Button
            variant="primary"
            className="h-7.5 flex-none px-3 text-xs"
            aria-expanded={starting}
            title="New Session: pick a Repo and a branch, or none, and talk to the agent"
            onClick={() => setStarting(!starting)}
          >
            + New
          </Button>
        </div>
        {starting && (
          <NewSession
            repos={repos.data.data}
            repoFilter={repoPicked}
            onCreated={(id) => {
              setStarting(false);
              onSelect(id);
            }}
          />
        )}
        <div className="flex items-center gap-1">
          <FilterTabs
            label="Session state"
            value={state}
            onChange={setState}
            filters={[
              { value: 'all', label: 'All' },
              { value: 'needs', label: 'Needs you', count: counts.needs, urgent: true },
              { value: 'running', label: 'Running', count: counts.running },
            ]}
          />
          <Dropdown
            label="Filter by Repo"
            caption=""
            variant="chip"
            opens="down"
            align="right"
            searchable
            value={repoPicked}
            options={repoOptions}
            onChange={setRepoFilter}
            className="ml-auto min-w-0"
            listClassName="w-max min-w-52 max-w-sm"
          />
        </div>
      </div>
      {group('needs', 'Needs you', 'bg-accent', needs)}
      {group('running', 'Running', 'bg-ok', running)}
      {group(
        'idle',
        'Idle',
        'bg-neutral-400',
        idle,
        !searching && (idleHidden > 0 || all) && idle.length > IDLE_SHOWN && (
          <li>
            <button
              type="button"
              onClick={() => setAll(!all)}
              className="cursor-pointer rounded-sm border-0 bg-transparent px-2.5 py-1 text-xs text-neutral-700 hover:text-text hover:underline"
            >
              {all ? 'Show fewer' : `Show ${idleHidden} more`}
            </button>
          </li>
        ),
      )}
      {listed.length === 0 && (
        <Empty>
          {searching
            ? `No Session matches “${q.trim()}”.`
            : sessions.data.length === 0
              ? 'No Sessions yet. Start one with + New.'
              : 'No Session in this view.'}
        </Empty>
      )}
      {repos.data.data.length === 0 && (
        <p className="m-0 px-4 pt-2 pb-3 text-xs text-neutral-700">Import a Repo in Repos to work on its branches.</p>
      )}
    </div>
  );
}
