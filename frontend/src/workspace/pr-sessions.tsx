import { PrState, type PullRequest, SessionKind } from '@ops-console/shared';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Spinner } from '../components/ui/button';
import { useCreateRepoSession, useRepoSessions } from '../lib/queries';
import { writeStored } from '../lib/remember';
import { sessionDraftKey, sessionPath } from './links';

/**
 * The Sessions on a pull request's branch, each a link to it, and New Session, which starts one there and opens it
 * with the pull request named in its draft, for the operator to say what to change.
 */
export function PrSessions({ pr }: { pr: PullRequest }) {
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
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-neutral-700">Sessions on {pr.branch}:</span>
      {onBranch.length === 0 && <span className="text-neutral-700">none</span>}
      {onBranch.map((session) => (
        <Link
          key={session.id}
          to={sessionPath(session.id)}
          className="rounded-full border border-line bg-card px-2.5 py-0.5 text-text no-underline hover:border-accent-300 hover:bg-accent-100"
        >
          {session.title} · {session.state.replace('_', ' ')}
        </Link>
      ))}
      {pr.state === PrState.Open && (
        <Button
          className="px-2.5 py-0.5 text-xs"
          disabled={repoId === null || create.isPending}
          title={
            repoId === null
              ? 'Import this repository in Repos to start a Session on it'
              : 'Start a Session on this branch and tell the agent what to change'
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
