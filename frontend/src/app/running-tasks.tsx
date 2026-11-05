import {
  type AgentRun,
  RunOutcome,
  type Session,
  SessionKind,
  SessionState,
  type Subagent,
  SubagentStatus,
} from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { StopRun } from '../agents/stop-run';
import { Button, Spinner } from '../components/ui/button';
import { Elapsed } from '../components/ui/elapsed';
import { useAgentRuns, useRepos, useRunControls } from '../lib/queries';
import { alertPath, pullRequestPath, sessionPath } from '../workspace/links';

const NEEDS_YOU: SessionState[] = [SessionState.WaitingInput, SessionState.WaitingApproval];

/** What a run's state chip means. */
const STATE_TIPS: Record<SessionState, string> = {
  [SessionState.Idle]: 'The agent is between turns.',
  [SessionState.Working]: 'The agent is working on it now.',
  [SessionState.WaitingInput]: 'The agent asked you something. Open it to answer.',
  [SessionState.WaitingApproval]: 'The agent waits for your yes or no on an action. Open it to answer.',
  [SessionState.Failed]: 'The run failed. Open it to read why.',
};

/** How an ended run reads, and what it means. It stays in the tray until dismissed. */
const OUTCOMES: Record<RunOutcome, { label: string; tip: string }> = {
  [RunOutcome.Done]: { label: 'done', tip: 'The run finished.' },
  [RunOutcome.Stopped]: { label: 'stopped', tip: 'You stopped the run. Play carries on from the conversation.' },
  [RunOutcome.Paused]: { label: 'paused', tip: 'You paused the run. Play carries on from where it stopped.' },
  [RunOutcome.Failed]: { label: 'failed', tip: 'The run failed. Retry starts it again.' },
  [RunOutcome.RateLimited]: {
    label: 'limit reached',
    tip: 'The Claude account hit its usage limit. Retry once the limit resets or another account is signed in.',
  },
  [RunOutcome.SignedOut]: {
    label: 'signed out',
    tip: 'The Claude sign-in stopped working. Sign in again, then Retry.',
  },
  [RunOutcome.Interrupted]: { label: 'interrupted', tip: 'The console restarted mid-run. Retry starts it again.' },
};

const SUBAGENT_TONE: Record<SubagentStatus, string> = {
  [SubagentStatus.Working]: 'bg-neutral-200 text-neutral-700',
  [SubagentStatus.Done]: 'bg-neutral-100 text-neutral-700',
  [SubagentStatus.Failed]: 'bg-accent-100 text-accent-700',
  [SubagentStatus.Stopped]: 'bg-accent-100 text-accent-700',
};

/** Where a running Session's work shows, and what to call it there. */
function placeOf(
  session: Session,
  repoName: (id: string | null) => string,
): { to: string; where: string; what: string; tip: string } {
  switch (session.kind) {
    case SessionKind.PrReview:
      return {
        to: session.repo_id && session.pr_number ? pullRequestPath(session.repo_id, session.pr_number) : '/workspace',
        where: repoName(session.repo_id),
        what: `Pull request #${session.pr_number}`,
        tip: 'Open the pull request this run works on',
      };
    case SessionKind.Devtools:
      return { to: '/devtools', where: 'Dev tools', what: session.title, tip: 'Open this Session in Dev tools' };
    case SessionKind.Anonymous:
      return { to: sessionPath(session.id), where: 'No Repo', what: session.title, tip: 'Open this Session' };
    default:
      return {
        to: sessionPath(session.id),
        where: repoName(session.repo_id),
        what: session.title,
        tip: 'Open this Session',
      };
  }
}

/** The subagents under `parent`, each with its own, in the order they started. */
function SubagentTree({
  all,
  parent,
  to,
  depth = 0,
}: {
  all: Subagent[];
  parent: string | null;
  to: string;
  depth?: number;
}) {
  const known = new Set(all.map((one) => one.id));
  // One whose parent is not listed hangs on the main agent.
  const children = all.filter(
    (one) => (one.parent_id !== null && known.has(one.parent_id) ? one.parent_id : null) === parent,
  );
  if (children.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {children.map((one) => (
        <li key={one.id}>
          <div
            className="flex items-center gap-2 rounded-md py-1.5 pr-2.5 hover:bg-text/6"
            style={{ paddingLeft: `${1.75 + depth * 1.1}rem` }}
          >
            <span aria-hidden className="flex-none text-neutral-600">
              ↳
            </span>
            <Link
              to={to}
              title="Open the Session this subagent works in"
              className="min-w-0 flex-1 text-text no-underline"
            >
              <span className="block truncate text-xs font-semibold">{one.description}</span>
              {one.type && <span className="block truncate text-[11px] text-neutral-700">{one.type}</span>}
            </Link>
            <Elapsed
              from={one.started_at}
              to={one.finished_at}
              running={one.status === SubagentStatus.Working}
              took={one.status !== SubagentStatus.Working}
            />
            <span className={`flex-none rounded-full px-2 py-px font-mono text-[11px] ${SUBAGENT_TONE[one.status]}`}>
              {one.status}
            </span>
          </div>
          <SubagentTree all={all} parent={one.id} to={to} depth={depth + 1} />
        </li>
      ))}
    </ul>
  );
}

/** Pause and Stop while the run goes; Play or Retry, and Dismiss, once it ended unfinished. */
function Controls({ run }: { run: AgentRun }) {
  const { session } = run;
  const { pause, resume, dismiss } = useRunControls(session.id);
  const error = pause.error ?? resume.error ?? dismiss.error;
  const small = 'px-2.5 py-1 text-xs';
  const play = run.outcome === RunOutcome.Paused || run.outcome === RunOutcome.Stopped;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1.5 pl-6.5">
      {run.running ? (
        <>
          {run.can_resume && (
            <Button
              title="Pause the run here. Play carries on from the conversation."
              className={small}
              disabled={pause.isPending}
              onClick={() => pause.mutate()}
            >
              {pause.isPending ? <Spinner /> : <PauseIcon />}
              Pause
            </Button>
          )}
          <StopRun sessionId={session.id} className={small} />
        </>
      ) : (
        <>
          {run.can_resume && (
            <Button
              variant="primary"
              title={play ? 'Carry on from where the run stopped' : 'Start the run again'}
              className={small}
              disabled={resume.isPending}
              onClick={() => resume.mutate()}
            >
              {resume.isPending ? <Spinner /> : play ? <PlayIcon /> : <RetryIcon />}
              {play ? 'Play' : 'Retry'}
            </Button>
          )}
          <Button
            title="Take this run out of the list"
            className={small}
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate()}
          >
            Dismiss
          </Button>
        </>
      )}
      {error && (
        <span role="alert" className="text-xs text-accent-700">
          {error.message}
        </span>
      )}
    </div>
  );
}

function PauseIcon() {
  return (
    <span aria-hidden className="inline-flex flex-none gap-0.5">
      <span className="h-2.5 w-0.75 bg-current" />
      <span className="h-2.5 w-0.75 bg-current" />
    </span>
  );
}

function PlayIcon() {
  return (
    <span
      aria-hidden
      className="inline-block size-0 flex-none border-y-[5px] border-l-[8px] border-y-transparent border-l-current"
    />
  );
}

function RetryIcon() {
  return <span aria-hidden>↻</span>;
}

/** One run: its title and place, how long it took, its state, its controls and, folded, its subagents. */
function RunEntry({ run, repoName }: { run: AgentRun; repoName: (id: string | null) => string }) {
  const { session } = run;
  const [open, setOpen] = useState(false);
  const place = placeOf(session, repoName);
  const needsYou = run.running && NEEDS_YOU.includes(session.state);
  const outcome = run.outcome ? OUTCOMES[run.outcome] : null;
  const going = run.subagents.filter((one) => one.status === SubagentStatus.Working).length;
  const chip = run.running
    ? { text: needsYou ? 'needs you' : session.state.replace('_', ' '), tip: STATE_TIPS[session.state] }
    : { text: outcome?.label ?? session.state, tip: outcome?.tip ?? STATE_TIPS[session.state] };
  return (
    <li className="rounded-md px-2.5 py-2 hover:bg-text/6">
      <div className="flex items-start gap-2">
        {run.subagents.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} ${run.subagents.length} ${run.subagents.length === 1 ? 'subagent' : 'subagents'}`}
            title={`${run.subagents.length} ${run.subagents.length === 1 ? 'subagent' : 'subagents'}${going > 0 ? `, ${going} working` : ''}`}
            onClick={() => setOpen(!open)}
            className="mt-0.5 flex size-4.5 flex-none cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-neutral-700 hover:text-text"
          >
            <span aria-hidden className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>
              ›
            </span>
          </button>
        ) : (
          <span aria-hidden className="size-4.5 flex-none" />
        )}
        <Link to={place.to} title={place.tip} className="min-w-0 flex-1 text-text no-underline">
          <span className="block truncate text-[13px] font-semibold">{place.what}</span>
          <span className="block truncate text-[11px] text-neutral-700">
            {place.where}
            {session.branch ? ` · ${session.branch}` : ''}
            {run.subagents.length > 0 &&
              ` · ${run.subagents.length} ${run.subagents.length === 1 ? 'subagent' : 'subagents'}`}
          </span>
        </Link>
        {session.alert_id && (
          <Link to={alertPath(session.alert_id)} className="text-[11px]" title="Open the Monitor Alert">
            Alert
          </Link>
        )}
        <span className="flex flex-none flex-col items-end gap-0.5">
          <span
            title={chip.tip}
            className={`rounded-full px-2 py-px font-mono text-[11px] ${
              needsYou || (!run.running && run.outcome !== RunOutcome.Done)
                ? 'bg-accent-100 text-accent-700'
                : 'bg-neutral-200 text-neutral-700'
            }`}
          >
            {chip.text}
          </span>
          <Elapsed from={run.started_at} to={run.finished_at} running={run.running} took={!run.running} />
        </span>
      </div>
      {!run.running && session.last_error && (
        <p className="m-0 pt-1 pl-6.5 text-[11px] text-accent-700">{session.last_error}</p>
      )}
      <Controls run={run} />
      {open && (
        <div className="pt-1.5">
          <SubagentTree all={run.subagents} parent={null} to={place.to} />
        </div>
      )}
    </li>
  );
}

/**
 * The sidebar's tray of every agent run in any Session: the ones going now, with their subagents, and the ones that
 * stopped, were paused or ran out of usage, which stay until dismissed. Each run opens where its work shows and can be
 * paused, stopped, played or retried from here.
 */
export function RunningTasks({ collapsed }: { collapsed: boolean }) {
  const runs = useAgentRuns().data ?? [];
  const repos = useRepos().data?.data ?? [];
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const going = runs.filter((run) => run.running);
  const ended = runs.length - going.length;
  const waiting = going.filter((run) => NEEDS_YOU.includes(run.session.state)).length;
  const repoName = (id: string | null) => repos.find((repo) => repo.id === id)?.name ?? 'Repo';

  // biome-ignore lint/correctness/useExhaustiveDependencies: moving to another page closes the list
  useEffect(() => setOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label =
    runs.length === 0
      ? 'No agent running'
      : [
          going.length > 0 ? `${going.length} agent ${going.length === 1 ? 'run' : 'runs'} going` : 'No agent running',
          waiting > 0 ? `${waiting} waiting on you` : null,
          ended > 0 ? `${ended} ended` : null,
        ]
          .filter(Boolean)
          .join(', ');
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label="Running agents"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(!open)}
        className={`flex h-8.5 w-full cursor-pointer items-center gap-2 border px-2.5 text-xs transition-colors ${
          waiting > 0
            ? 'border-accent-300 bg-accent-100 text-accent-900'
            : 'border-line bg-card text-text hover:bg-neutral-200'
        } ${collapsed ? 'justify-center' : ''}`}
      >
        <span
          aria-hidden
          className={`size-2 flex-none rounded-full ${going.length > 0 ? 'animate-pulse bg-accent' : ended > 0 ? 'bg-accent-300' : 'bg-neutral-400'}`}
        />
        {!collapsed && <span className="min-w-0 flex-1 truncate text-left">Running</span>}
        <span className="font-mono font-semibold">{going.length}</span>
        {!collapsed && ended > 0 && <span className="font-mono text-neutral-700">+{ended}</span>}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Agent runs going now"
          className="absolute bottom-0 left-full z-50 ml-2 flex max-h-[80vh] w-120 max-w-[calc(100vw-20rem)] flex-col overflow-hidden rounded-xl border border-line bg-card shadow-lg"
        >
          <header className="border-b border-divider px-4 py-2.5 text-xs font-extrabold">{label}</header>
          {runs.length === 0 ? (
            <p className="m-0 px-4 py-3 text-xs text-neutral-700">
              Runs show here while the agent works or waits on you, in any Session. One you stop or one that runs out of
              usage stays until you dismiss it.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col overflow-y-auto p-1.5">
              {runs.map((run) => (
                <RunEntry key={run.session.id} run={run} repoName={repoName} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
