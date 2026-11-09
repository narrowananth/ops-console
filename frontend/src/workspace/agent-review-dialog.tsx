import { useRef, useState } from 'react';
import { ConfirmDialog } from '../components/ui/confirm-dialog';

/** Agent Review's start dialog: an optional note that narrows the review. Start sends it with the review. */
export function AgentReviewDialog({ onStart, onCancel }: { onStart: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  return (
    <ConfirmDialog
      title="Agent Review"
      action="Start"
      initialFocus={field}
      onConfirm={() => onStart(note.trim())}
      onCancel={onCancel}
    >
      <p className="m-0 mb-2">
        Optional. Tell the agent where to look or what to read first, such as a related pull request this one continues.
        The agent follows the Review PR Playbook with your note.
      </p>
      <textarea
        ref={field}
        aria-label="Note for the agent"
        value={note}
        rows={4}
        placeholder="Example: continues #123; check the retry path and the migration"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onStart(note.trim());
        }}
        className="field-sizing-content max-h-[40vh] min-h-24 w-full resize-y overflow-y-auto rounded-md border border-divider bg-bg px-2.5 py-2 font-body text-[13px] leading-relaxed text-text outline-none focus:border-accent-400 focus:shadow-[0_0_0_3px_var(--color-accent-100)]"
      />
      <span title="⌘Enter or Ctrl+Enter starts the review." className="text-xs text-neutral-600">
        Markdown · ⌘↵ to start
      </span>
    </ConfirmDialog>
  );
}
