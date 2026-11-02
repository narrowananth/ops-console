import type { PullRequestDetail } from '@ops-console/shared';
import { useState } from 'react';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { firstLine, openLineThreads } from './pr-jobs';

/** Address comments' list: every unresolved thread on a line, all ticked. Start sends the ticked ones. */
export function AddressCommentsDialog({
  pr,
  onStart,
  onCancel,
}: {
  pr: PullRequestDetail;
  onStart: (commentIds: string[]) => void;
  onCancel: () => void;
}) {
  const threads = openLineThreads(pr);
  const [ticked, setTicked] = useState(() => new Set(threads.map((thread) => thread.id)));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(id);
    else next.delete(id);
    setTicked(next);
  };
  return (
    <ConfirmDialog
      title="Address comments"
      action="Start"
      disabled={ticked.size === 0}
      onConfirm={() => onStart(threads.filter((thread) => ticked.has(thread.id)).map((thread) => thread.id))}
      onCancel={onCancel}
    >
      <p className="m-0 mb-2">
        The agent makes the changes the ticked threads ask for, pushes one commit to {pr.branch}, replies in each thread
        and resolves the ones it did.
      </p>
      <ul aria-label="Threads" className="m-0 flex max-h-80 list-none flex-col gap-1 overflow-y-auto p-0">
        {threads.map((thread) => (
          <li key={thread.id}>
            <label className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-neutral-200">
              <input
                type="checkbox"
                className="m-0 mt-0.5 size-3.5 flex-none cursor-pointer accent-[var(--color-accent)]"
                checked={ticked.has(thread.id)}
                onChange={(event) => toggle(thread.id, event.target.checked)}
              />
              <span className="flex min-w-0 flex-col">
                <span className="flex gap-2 text-xs">
                  <span className="min-w-0 truncate font-mono text-text">
                    {thread.file_path}:{thread.line}
                  </span>
                  <span className="flex-none">{thread.author}</span>
                </span>
                <span className="truncate">{firstLine(thread.body)}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}
