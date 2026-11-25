import { type PrActionSession, PrActionState, PrState, type PullRequestDetail, SessionKind } from '@ops-console/shared';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Spinner } from '../components/ui/button';
import { useCreateRepoSession, useRepoSessions } from '../lib/queries';
import { writeStored } from '../lib/remember';
import { sessionDraftKey, sessionPath } from './links';
import { ACTION_LABEL, ACTION_STATE_LABEL, commitUrl, LINKED_TITLE } from './pr-jobs';

/** What a Round, or an older PR action Session, has done: its commit, and whether the pull request moved past it. */
function RoundMarks({ pr, round }: { pr: PullRequestDetail; round: PrActionSession }) {
  const href = round.commit_sha && commitUrl(pr.url, round.commit_sha);
  return (
    <>
      {round.commit_sha &&
        (href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            title="The commit this Round pushed, on the Git host"
            className="flex-none font-mono text-text"
          >
            {round.commit_sha.slice(0, 7)}
          </a>
        ) : (
          <span title="The commit this Round pushed" className="flex-none font-mono text-neutral-700">
            {round.commit_sha.slice(0, 7)}
          </span>
        ))}
      {round.stale && (
        <span
          title="The pull request has newer commits than this Round worked on"
          className="flex-none text-neutral-600"
        >
          older commit
        </span>
      )}
    </>
  );
}

/**
 * The pull request's PR Session with its current Round, then the operator's Sessions on its branch or that opened it,
 * each a link, and New Session, which starts one there and opens it with the pull request named in its draft, for the
 * operator to say what to change. New Session waits while any of those Sessions exists.
 */
export function PrSessions({ pr }: { pr: PullRequestDetail }) {
  const sessions = useRepoSessions();
  const create = useCreateRepoSession();
  const navigate = useNavigate();
  const repoId = pr.repo_id;
  const [session, ...older] = pr.action_sessions;
  const onBranch = (sessions.data ?? []).filter(
    (session) =>
      session.kind === SessionKind.Repo &&
      session.repo_id === repoId &&
      (session.branch === pr.branch || session.pull_requests.some((opened) => opened.number === pr.number)),
  );
  const linked = session !== undefined || onBranch.length > 0;
  const start = () => {
    if (repoId === null) return;
    create.mutate(
      { repo_id: repoId, branch: pr.branch, from_origin: true },
      {
        onSuccess: (session) => {
          writeStored(sessionDraftKey(session.id), `On pull request #${pr.number} (${pr.title}): `, '');
          navigate(sessionPath(session.id));
        },
      },
    );
  };

  return (
    <div className="flex flex-col items-stretch gap-2 text-xs">
      <span title="Your Sessions checked out on this pull request's branch" className="text-neutral-700">
        Sessions on this pull request:
      </span>
      {session && (
        <div className="flex min-w-0 flex-col gap-1 rounded-md border border-line bg-card px-2.5 py-1">
          <Link
            to={sessionPath(session.session_id)}
            title="Open this Session. The agent works here, one Round per button press; the console posts what each Round submits to the Git host."
            className="min-w-0 truncate text-text no-underline hover:underline"
          >
            Pull request #{pr.number} · {session.state === PrActionState.Working ? 'working' : 'idle'}
          </Link>
          <div className="flex min-w-0 items-center gap-1.5 text-neutral-700">
            <span title="The Round: the button the agent was last asked from" className="min-w-0 truncate">
              {ACTION_LABEL[session.action]} · {ACTION_STATE_LABEL[session.state]}
            </span>
            <RoundMarks pr={pr} round={session} />
          </div>
        </div>
      )}
      {older.map((action) => (
        <div
          key={action.session_id}
          className="flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-card px-2.5 py-1"
        >
          <Link
            to={sessionPath(action.session_id)}
            title="An older Session from a button press. It stays in the list and the console does not reuse it."
            className="min-w-0 truncate text-text no-underline hover:underline"
          >
            {ACTION_LABEL[action.action]} · {ACTION_STATE_LABEL[action.state]}
          </Link>
          <RoundMarks pr={pr} round={action} />
        </div>
      ))}
      {pr.action_sessions.length === 0 && onBranch.length === 0 && <span className="text-neutral-700">none</span>}
      {onBranch.map((session) => (
        <Link
          key={session.id}
          to={sessionPath(session.id)}
          title="Open this Session"
          className="truncate rounded-md border border-line bg-card px-2.5 py-1 text-text no-underline hover:border-accent-300 hover:bg-accent-100"
        >
          {session.title} · {session.state.replace('_', ' ')}
        </Link>
      ))}
      {pr.state === PrState.Open && (
        <Button
          className="justify-center px-2.5 py-1 text-xs"
          disabled={repoId === null || create.isPending || linked}
          title={
            repoId === null
              ? 'Import this repository in Repos to start a Session on it'
              : linked
                ? LINKED_TITLE
                : 'Start a Session on this branch and tell the agent what to change. A branch only on origin is fetched first.'
          }
          onClick={start}
        >
          {create.isPending && <Spinner />}
          New Session
        </Button>
      )}
      {create.isError && (
        <span role="alert" className="text-accent-700">
          {create.error.message}
        </span>
      )}
    </div>
  );
}
