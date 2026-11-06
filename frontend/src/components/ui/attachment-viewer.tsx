import { useEffect, useRef, useState } from 'react';
import { apiBlob } from '../../lib/api';
import { Button } from './button';
import { CodeBlock } from './code-block';

export const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The daemon's address for a saved file: its path ends `attachments/<session id>/<file>`. */
export function attachmentAddress(path: string): string {
  const [file = '', sessionId = ''] = path.split('/').reverse();
  return `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(file)}`;
}

/** The daemon's address for a file the agent wrote for the operator. */
export const outputAddress = (sessionId: string, name: string) =>
  `/sessions/${encodeURIComponent(sessionId)}/outputs/${encodeURIComponent(name)}`;

/** What the viewer opens: a file on this page, an attachment saved by the daemon, or a file at a daemon address. */
export type Viewed = { name: string; file: File } | { name: string; path: string } | { name: string; address: string };

/**
 * An attached file opened over the page: an image or PDF as itself, text as text, anything else to download.
 * Escape, Close and a click on the dimmed page close it.
 */
export function AttachmentViewer({ viewed, onClose }: { viewed: Viewed; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [blob, setBlob] = useState<Blob | null>('file' in viewed ? viewed.file : null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const box = dialog.current;
    if (!box || box.open) return;
    box.showModal();
    return () => box.close();
  }, []);
  useEffect(() => {
    if ('file' in viewed) return;
    apiBlob('address' in viewed ? viewed.address : attachmentAddress(viewed.path)).then(setBlob, (failure: unknown) =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, [viewed]);
  const kind = blob ? viewKind(blob.type, viewed.name) : null;
  useEffect(() => {
    if (!blob) return;
    const made = URL.createObjectURL(blob);
    setUrl(made);
    if (kind === 'text')
      blob
        .slice(0, TEXT_SHOWN)
        .text()
        .then(setText, () => setText(null));
    return () => URL.revokeObjectURL(made);
  }, [blob, kind]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes a modal dialog natively; the click is the backdrop
    <dialog
      ref={dialog}
      aria-label={viewed.name}
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
        <h2 className="m-0 min-w-0 flex-1 truncate font-mono text-sm font-semibold">{viewed.name}</h2>
        {blob && <span className="font-mono text-xs text-neutral-700">{size(blob.size)}</span>}
        {url && (
          <a
            href={url}
            download={viewed.name}
            className="rounded-md px-2 py-1 text-xs text-neutral-700 no-underline hover:bg-neutral-200 hover:text-text"
          >
            Download
          </a>
        )}
        <Button className="px-2.5 py-1 text-xs" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="flex min-h-40 flex-1 items-center justify-center overflow-auto bg-bg">
        {error ? (
          <p role="alert" className="m-0 p-6 text-sm text-accent-700">
            Could not open the file: {error}
          </p>
        ) : !url || !kind ? (
          <p className="m-0 p-6 text-sm text-neutral-700">Opening…</p>
        ) : kind === 'image' ? (
          <img src={url} alt={viewed.name} className="max-h-[calc(100vh-120px)] max-w-full object-contain" />
        ) : kind === 'pdf' ? (
          <iframe title={viewed.name} src={url} className="h-[calc(100vh-120px)] w-full border-0" />
        ) : kind === 'text' ? (
          <CodeBlock
            text={text ?? ''}
            note={blob && blob.size > TEXT_SHOWN ? '\n… the rest is cut here. Download shows all of it.' : undefined}
            tone="light"
            wrapperClassName="h-full w-full self-start"
            className="m-0 h-full w-full overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap"
          />
        ) : (
          <p className="m-0 p-6 text-sm text-neutral-700">No preview for this kind of file. Download opens it.</p>
        )}
      </div>
    </dialog>
  );
}

const TEXT_SHOWN = 256 * 1024;
const TEXT_NAME = /\.(csv|json|log|md|sql|txt|xml|ya?ml)$/i;

function viewKind(type: string, name: string): 'image' | 'pdf' | 'text' | 'other' {
  if (type.startsWith('image/') && type !== 'image/svg+xml') return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('text/') || type === 'application/json' || TEXT_NAME.test(name)) return 'text';
  return 'other';
}

export function PaperClip() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="flex-none">
      <path
        d="M13 7.5 8 12.5a3.2 3.2 0 0 1-4.5-4.5l5.3-5.3a2.1 2.1 0 0 1 3 3L6.6 10.9a1 1 0 0 1-1.5-1.5L10 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
