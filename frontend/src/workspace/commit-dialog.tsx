import { useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '../components/ui/button';
import { useCommitSession } from '../lib/queries';

/**
 * Commits what the agent or the operator changed in the Session's worktree. A blank message is written by the console
 * from the file names. "Commit on new branch" makes a branch from the current one first, and the Session follows it.
 */
export function CommitDialog({
  sessionId,
  branch,
  files,
  additions,
  deletions,
  onClose,
}: {
  sessionId: string;
  branch: string;
  /** Files with changes not committed yet. */
  files: number;
  additions: number | null;
  deletions: number | null;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const commit = useCommitSession(sessionId);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const box = dialog.current;
    if (!box || box.open) return;
    box.showModal();
    field.current?.focus();
    return () => box.close();
  }, []);

  const go = (new_branch: boolean) => commit.mutate({ message, new_branch }, { onSuccess: onClose });

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a modal dialog natively; the click is the backdrop
    <dialog
      ref={dialog}
      aria-labelledby="commit-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!commit.isPending) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !commit.isPending) onClose();
      }}
      className="m-auto w-[min(560px,calc(100vw-32px))] rounded-2xl border border-line bg-card p-0 text-text shadow-2xl backdrop:bg-neutral-900/35"
    >
      <div className="flex flex-col gap-3 px-6 pt-5 pb-4">
        <h2 id="commit-title" className="m-0 font-heading text-lg">
          Commit changes
        </h2>
        <p className="m-0 text-sm text-neutral-700">
          Review and confirm your commit. Leave the message blank to write one from the files.
        </p>
        <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface/50 px-4 py-3 text-sm">
          <div className="flex items-baseline gap-2">
            <span className="text-neutral-700">Branch</span>
            <span className="min-w-0 truncate font-mono">{branch}</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-neutral-700">Files</span>
            <span>{files === 1 ? '1 file' : `${files} files`} not committed yet</span>
            {additions !== null && deletions !== null && (
              <span className="ml-auto font-mono text-xs font-semibold" title="The whole branch against its base">
                <span className="text-diff-add-text">+{additions}</span>{' '}
                <span className="text-diff-del-text">−{deletions}</span>
              </span>
            )}
          </div>
        </div>
        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          Commit message (optional)
          <textarea
            ref={field}
            value={message}
            disabled={commit.isPending}
            placeholder="Leave empty to auto-generate"
            rows={3}
            onChange={(event) => setMessage(event.target.value)}
            className="w-full resize-y rounded-lg border border-divider bg-card px-3 py-2 text-sm font-normal text-text outline-none focus:border-accent-400"
          />
        </label>
        {commit.isError && (
          <p role="alert" className="m-0 text-xs text-accent-700">
            {commit.error.message}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-6 py-3">
        <Button className="px-3 py-1.5 text-xs" disabled={commit.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button className="px-3 py-1.5 text-xs" disabled={commit.isPending} onClick={() => go(true)}>
          Commit on new branch
        </Button>
        <Button variant="primary" className="px-3 py-1.5 text-xs" disabled={commit.isPending} onClick={() => go(false)}>
          {commit.isPending && <Spinner />}
          Commit
        </Button>
      </div>
    </dialog>
  );
}
