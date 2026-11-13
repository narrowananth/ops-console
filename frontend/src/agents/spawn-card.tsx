import { type Part, RunOutcome, SessionState, type SpawnedSession } from '@ops-console/shared';
import { Link } from 'react-router-dom';
import { useRepoSessions } from '../lib/queries';
import { sessionPath } from '../workspace/links';
import { SESSION_STATE_TIP } from '../workspace/sessions-pane';

type SpawnPart = Extract<Part, { kind: 'spawn' }>;

/** How a run that ended any way but done reads on a child's row. */
const OUTCOME: Record<RunOutcome, string | null> = {
  [RunOutcome.Done]: null,
  [RunOutcome.Stopped]: 'stopped',
  [RunOutcome.Paused]: 'paused',
  [RunOutcome.Failed]: 'failed',
  [RunOutcome.RateLimited]: 'out of usage',
  [RunOutcome.SignedOut]: 'signed out',
  [RunOutcome.Interrupted]: 'interrupted by a restart',
};

function ChildRow({ child }: { child: SpawnedSession }) {
  const ended = child.state === SessionState.Idle && child.run_outcome ? OUTCOME[child.run_outcome] : null;
  const label = ended ?? child.state.replace('_', ' ');
  const going = child.state !== SessionState.Idle && child.state !== SessionState.Failed;
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
      <span className="font-semibold text-text">{child.repo_name ?? 'No Repo'}</span>
      <span
        title={SESSION_STATE_TIP[child.state]}
        className={`flex-none rounded-full px-1.75 font-mono ${going ? 'bg-accent-100 text-accent-700' : 'bg-neutral-200 text-neutral-700'}`}
      >
        {label}
      </span>
      {child.branch && (
        <span title="The branch this Session works on" className="max-w-60 truncate font-mono text-neutral-700">
          {child.branch}
        </span>
      )}
      {child.pull_request && (
        <a
          href={child.pull_request.url}
          target="_blank"
          rel="noreferrer"
          title="Open this pull request on the Git host"
          className="rounded-full border border-line bg-card px-2 py-0.5 text-text no-underline hover:border-accent-300 hover:bg-accent-100"
        >
          PR #{child.pull_request.number} ↗
        </a>
      )}
      <Link
        to={sessionPath(child.id)}
        title={`Open the Session "${child.title}"`}
        className="ml-auto rounded-md px-2 py-0.5 font-semibold text-text no-underline hover:bg-neutral-200"
      >
        Open
      </Link>
    </li>
  );
}

/**
 * The agent's `spawn_sessions` call in a Session's transcript: the Sessions it started, each with its state, branch
 * and pull request, kept fresh by `session.updated`. Read from the call's own children, so it holds after a reload.
 */
export function SpawnCard({ part, sessionId }: { part: SpawnPart; sessionId: string }) {
  const sessions = useRepoSessions();
  const parent = sessions.data?.find((one) => one.id === sessionId);
  const children = parent?.spawned.filter((child) => child.call_id === part.call_id) ?? [];
  const asked = part.entries.length;
  const waiting = parent?.state === SessionState.WaitingApproval;
  return (
    <section
      aria-label="Sessions started together"
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-3.5 py-2.5"
    >
      <span className="text-xs font-semibold tracking-wide text-neutral-700 uppercase">
        {children.length === 0
          ? `${asked} Session${asked === 1 ? '' : 's'} asked for`
          : `Started ${children.length} of ${asked} Session${asked === 1 ? '' : 's'}`}
      </span>
      {children.length === 0 ? (
        <span className="text-xs text-neutral-700">
          {parent === undefined
            ? 'Reading the Sessions…'
            : waiting
              ? 'Waiting for your Approval.'
              : 'Not started: the Approval was denied, or the list was refused. The tasks stay with you.'}
        </span>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {children.map((child) => (
            <ChildRow key={child.id} child={child} />
          ))}
        </ul>
      )}
    </section>
  );
}
