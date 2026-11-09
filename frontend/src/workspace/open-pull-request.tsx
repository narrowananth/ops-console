import { ErrorCode, PR_DESCRIPTION_LIMIT } from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Spinner } from '../components/ui/button';
import { ApiError } from '../lib/api';
import { usePasteLimit } from '../lib/paste-limit';
import { useDraftPullRequest, useOpenPullRequest } from '../lib/queries';

const FIELD =
  'w-full rounded-md border border-line bg-card px-2.5 py-1.5 text-sm text-text read-only:bg-neutral-200 focus-visible:outline-2 focus-visible:outline-accent';

/**
 * The form that opens a pull request for the Session's branch. The agent drafts the title and description; the
 * operator edits them. The console pushes the branch and opens the pull request, so the agent never pushes.
 */
export function OpenPullRequestForm({
  sessionId,
  baseBranch,
  uncommittedFiles,
  onClose,
}: {
  sessionId: string;
  baseBranch: string;
  uncommittedFiles: number;
  onClose: () => void;
}) {
  const draft = useDraftPullRequest(sessionId);
  const open = useOpenPullRequest(sessionId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const paste = usePasteLimit(PR_DESCRIPTION_LIMIT, 'fit');
  const [base, setBase] = useState(baseBranch);
  const asked = useRef(false);
  const { mutate: ask } = draft;
  // One draft turn per opening of the form.
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    ask(baseBranch, {
      onSuccess: (drafted) => {
        setTitle(drafted.title ?? '');
        setDescription(drafted.description ?? '');
      },
    });
  }, [ask, baseBranch]);

  // The form is read-only from the first render until the draft ends, so a typed word is never overwritten by it.
  const drafting = draft.isIdle || draft.isPending;
  const error = open.error ?? draft.error;
  const confirm = () => open.mutate({ title, description, base_branch: base }, { onSuccess: onClose });

  return (
    <form
      aria-label="Open pull request"
      className="flex flex-col gap-2 border-b border-line bg-neutral-100 px-6 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        confirm();
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-neutral-700">
        Title
        <input
          className={FIELD}
          value={title}
          readOnly={drafting}
          placeholder={drafting ? 'The agent is writing the title…' : 'Title'}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-neutral-700">
        Description
        <textarea
          className={`${FIELD} min-h-32 resize-y font-mono`}
          value={description}
          readOnly={drafting}
          maxLength={PR_DESCRIPTION_LIMIT}
          placeholder={drafting ? 'The agent is writing the description…' : 'Description'}
          onPaste={paste.onPaste}
          onChange={(event) => {
            paste.clear();
            setDescription(event.target.value);
          }}
        />
        {paste.over && (
          <span role="alert" className="text-accent-700">
            The description holds {PR_DESCRIPTION_LIMIT.toLocaleString()} characters at most. The rest of the paste was
            left out.
          </span>
        )}
      </label>
      <label className="flex flex-col gap-1 text-xs text-neutral-700">
        Base branch
        <input
          className={`${FIELD} max-w-80 font-mono`}
          value={base}
          onChange={(event) => setBase(event.target.value)}
        />
      </label>
      {uncommittedFiles > 0 && (
        <p className="m-0 text-xs text-neutral-700">
          {uncommittedFiles} {uncommittedFiles === 1 ? 'file has' : 'files have'} changes that are not committed. The
          pull request leaves them out.
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-xs text-accent-700">
          {error instanceof Error ? error.message : 'The pull request did not open.'}{' '}
          {error instanceof ApiError && error.code === ErrorCode.ConnectorNotConnected && (
            <Link to="/integrations" className="text-accent-700 underline">
              Connect it in Integrations
            </Link>
          )}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          className="px-3 py-1 text-xs"
          disabled={drafting || open.isPending || title.trim() === '' || base.trim() === ''}
          title="Push the branch to origin and open the pull request on the Git host"
        >
          {open.isPending ? (
            <>
              <Spinner /> Opening…
            </>
          ) : (
            'Open pull request'
          )}
        </Button>
        <Button className="px-3 py-1 text-xs" disabled={open.isPending} onClick={onClose}>
          Cancel
        </Button>
        {drafting && (
          <span className="flex items-center gap-1.5 text-xs text-neutral-700">
            <Spinner /> The agent is drafting
          </span>
        )}
      </div>
    </form>
  );
}
