import { ErrorCode } from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Spinner } from '../components/ui/button';
import { ApiError } from '../lib/api';
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
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const box = dialog.current;
    if (!box || box.open) return;
    box.showModal();
    return () => box.close();
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a modal dialog natively; the click is the backdrop
    <dialog
      ref={dialog}
      aria-labelledby="open-pr-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!open.isPending) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !open.isPending) onClose();
      }}
      className="m-auto w-[min(640px,calc(100vw-32px))] rounded-2xl border border-line bg-card p-0 text-text shadow-2xl backdrop:bg-neutral-900/35"
    >
      <form
        aria-label="Open pull request"
        className="flex flex-col gap-3 px-6 pt-5 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        <h2 id="open-pr-title" className="m-0 font-heading text-lg">
          Open pull request
        </h2>
        <p className="m-0 text-sm text-neutral-700">
          The console pushes the branch to origin and opens the pull request on the Git host. The agent drafted the
          text; edit it first.
        </p>
        <label className="flex flex-col gap-1 text-xs text-neutral-700">
          Title
          <input
            className={FIELD}
            value={title}
            readOnly={drafting}
            placeholder={drafting ? 'Reading the commits…' : 'Title'}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-700">
          Description
          <textarea
            className={`${FIELD} min-h-32 resize-y font-mono`}
            value={description}
            readOnly={drafting}
            placeholder={drafting ? 'Reading the commits…' : 'Description'}
            onChange={(event) => setDescription(event.target.value)}
          />
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
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          {drafting && (
            <span className="mr-auto flex items-center gap-1.5 text-xs text-neutral-700">
              <Spinner /> The agent is drafting
            </span>
          )}
          <Button className="px-3 py-1.5 text-xs" disabled={open.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            className="px-3 py-1.5 text-xs"
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
        </div>
      </form>
    </dialog>
  );
}
