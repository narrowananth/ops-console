import { useEffect, useRef, useState } from 'react';
import { attachmentAddress } from '../components/ui/attachment-viewer';
import { Button } from '../components/ui/button';
import { apiBlob } from '../lib/api';

/** What the editor opens: the pasted text on this page, or its saved copy at the daemon. */
export type PastedText = { name: string; file: File } | { name: string; path: string };

/**
 * A pasted text file opened to edit over the page. Save puts the new text in the same file; Clear empties the file out
 * of the message. Escape and a click on the dimmed page close it without saving.
 */
export function PastedTextEditor({
  pasted,
  onSave,
  onClear,
  onClose,
}: {
  pasted: PastedText;
  onSave: (text: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const box = dialog.current;
    if (!box || box.open) return;
    box.showModal();
    return () => box.close();
  }, []);
  useEffect(() => {
    const blob = 'file' in pasted ? Promise.resolve<Blob>(pasted.file) : apiBlob(attachmentAddress(pasted.path));
    blob.then(
      (found) => found.text().then(setText),
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, [pasted]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a modal dialog natively; the click is the backdrop
    <dialog
      ref={dialog}
      aria-label={`Edit ${pasted.name}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto flex max-h-[calc(100vh-48px)] w-[min(1100px,calc(100vw-48px))] flex-col overflow-hidden rounded-xl border border-line bg-card p-0 text-text shadow-2xl backdrop:bg-neutral-900/55"
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="m-0 min-w-0 flex-1 truncate font-mono text-sm font-semibold">{pasted.name}</h2>
        {text !== null && (
          <span className="font-mono text-xs text-neutral-700">{text.length.toLocaleString()} chars</span>
        )}
        <Button className="px-2.5 py-1 text-xs" onClick={onClear}>
          Clear
        </Button>
        <Button className="px-2.5 py-1 text-xs" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          className="px-2.5 py-1 text-xs"
          disabled={text === null}
          onClick={() => onSave(text ?? '')}
        >
          Save
        </Button>
      </div>
      {error ? (
        <p role="alert" className="m-0 p-6 text-sm text-accent-700">
          Could not open the file: {error}
        </p>
      ) : text === null ? (
        <p className="m-0 p-6 text-sm text-neutral-700">Opening…</p>
      ) : (
        <textarea
          aria-label={`Text of ${pasted.name}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          className="m-0 h-[70vh] w-full resize-none border-0 bg-bg p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-text outline-none"
        />
      )}
    </dialog>
  );
}
