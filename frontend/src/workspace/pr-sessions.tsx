import { PrState, type PullRequestDetail, SessionKind } from '@ops-console/shared';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Spinner } from '../components/ui/button';
import { useCreateRepoSession, useRepoSessions } from '../lib/queries';
import { writeStored } from '../lib/remember';
import { sessionDraftKey, sessionPath } from './links';
import { ACTION_LABEL, ACTION_STATE_LABEL, commitUrl } from './pr-jobs';

/**
 * The PR action Sessions on a pull request, then the operator's Sessions on its branch, each a link, and New Session,
 * which starts one there and opens it with the pull request named in its draft, for the operator to say what to change.
 */
export function PrSessions({ pr }: { pr: PullRequestDetail }) {
  const sessions = useRepoSessions();
  const create = useCreateRepoSession();
  const navigate = useNavigate();
  const repoId = pr.repo_id;
  const onBranch = (sessions.data ?? []).filter(
    (session) => session.kind === SessionKind.Repo && session.repo_id === repoId && session.branch === pr.branch,
  );
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
        Sessions on {pr.branch}:
      </span>
      {pr.action_sessions.map((action) => {
        const href = action.commit_sha && commitUrl(pr.url, action.commit_sha);
        return (
          <div
            key={action.session_id}
            className="flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-card px-2.5 py-1"
          >
            <Link
              to={sessionPath(action.session_id)}
              title="Open this Session. The agent works here; the console posts what it submits to the Git host."
              className="min-w-0 truncate text-text no-underline hover:underline"
            >
              {ACTION_LABEL[action.action]} · {ACTION_STATE_LABEL[action.state]}
            </Link>
            {action.commit_sha &&
              (href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  title="The commit this Session pushed, on the Git host"
                  className="flex-none font-mono text-text"
                >
                  {action.commit_sha.slice(0, 7)}
                </a>
              ) : (
                <span title="The commit this Session pushed" className="flex-none font-mono text-neutral-700">
                  {action.commit_sha.slice(0, 7)}
                </span>
              ))}
            {action.stale && (
              <span
                title="The pull request has newer commits than this Session worked on"
                className="flex-none text-neutral-600"
              >
                older commit
              </span>
            )}
          </div>
        );
      })}
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
          disabled={repoId === null || create.isPending}
          title={
            repoId === null
              ? 'Import this repository in Repos to start a Session on it'
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
