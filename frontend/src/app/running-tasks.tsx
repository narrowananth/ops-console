import { type Session, SessionKind, SessionState } from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useRepos, useRunningSessions } from '../lib/queries';
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

/** Where a running Session's work shows, and what to call it there. */
function placeOf(
  session: Session,
  repoName: (id: string | null) => string,
): { to: string; where: string; what: string } {
  switch (session.kind) {
    case SessionKind.PrReview:
      return {
        to: session.repo_id && session.pr_number ? pullRequestPath(session.repo_id, session.pr_number) : '/workspace',
        where: repoName(session.repo_id),
        what: `Pull request #${session.pr_number}`,
      };
    case SessionKind.Devtools:
      return { to: '/devtools', where: 'Dev tools', what: session.title };
    case SessionKind.Anonymous:
      return { to: sessionPath(session.id), where: 'No Repo', what: session.title };
    default:
      return { to: sessionPath(session.id), where: repoName(session.repo_id), what: session.title };
  }
}

/**
 * The sidebar's tray of every agent run going now, in any Session: its count, tinted when one waits on the operator,
 * and a list that opens each where its work shows.
 */
export function RunningTasks({ collapsed }: { collapsed: boolean }) {
  const running = useRunningSessions().data ?? [];
  const repos = useRepos().data?.data ?? [];
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const waiting = running.filter((session) => NEEDS_YOU.includes(session.state)).length;
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
    running.length === 0
      ? 'No agent running'
      : `${running.length} agent ${running.length === 1 ? 'run' : 'runs'} going${waiting > 0 ? `, ${waiting} waiting on you` : ''}`;
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
          className={`size-2 flex-none rounded-full ${running.length > 0 ? 'animate-pulse bg-accent' : 'bg-neutral-400'}`}
        />
        {!collapsed && <span className="min-w-0 flex-1 truncate text-left">Running</span>}
        <span className="font-mono font-semibold">{running.length}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Agent runs going now"
          className="absolute bottom-0 left-full z-50 ml-2 flex max-h-[70vh] w-88 flex-col overflow-hidden rounded-xl border border-line bg-card shadow-lg"
        >
          <header className="border-b border-divider px-4 py-2.5 text-xs font-extrabold">{label}</header>
          {running.length === 0 ? (
            <p className="m-0 px-4 py-3 text-xs text-neutral-700">
              Runs show here while the agent works or waits on you, in any Session.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col overflow-y-auto p-1.5">
              {running.map((session) => {
                const place = placeOf(session, repoName);
                const needsYou = NEEDS_YOU.includes(session.state);
                return (
                  <li key={session.id} className="flex items-center gap-2 rounded-md px-2.5 py-2 hover:bg-text/6">
                    <Link
                      to={place.to}
                      title="Open where this run shows"
                      className="min-w-0 flex-1 text-text no-underline"
                    >
                      <span className="block truncate text-[13px] font-semibold">{place.what}</span>
                      <span className="block truncate text-[11px] text-neutral-700">
                        {place.where}
                        {session.branch ? ` · ${session.branch}` : ''}
                      </span>
                    </Link>
                    {session.alert_id && (
                      <Link to={alertPath(session.alert_id)} className="text-[11px]" title="Open the Monitor Alert">
                        Alert
                      </Link>
                    )}
                    <span
                      title={STATE_TIPS[session.state]}
                      className={`flex-none rounded-full px-2 py-px font-mono text-[11px] ${
                        needsYou ? 'bg-accent-100 text-accent-700' : 'bg-neutral-200 text-neutral-700'
                      }`}
                    >
                      {needsYou ? 'needs you' : session.state.replace('_', ' ')}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
