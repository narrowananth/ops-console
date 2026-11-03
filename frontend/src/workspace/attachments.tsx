import { type Attachment, attachmentSchema } from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiUpload } from '../lib/api';

/** A file on its way into the next message: uploading, saved, or refused. */
type Pending = {
  key: string;
  file: File;
  /** A thumbnail for images, while the chip shows. */
  preview: string | null;
  saved: Attachment | null;
  error: string | null;
};

const saved = z.object({ data: attachmentSchema });

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * The files attached to the message being written. Each uploads as soon as it is added: picked, dropped or pasted.
 * `ready` holds the saved ones; `uploading` says whether any is still on its way.
 */
export function useAttachments(sessionId: string) {
  const [pending, setPending] = useState<Pending[]>([]);
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);
  const update = (key: string, change: Partial<Pending>) =>
    setPending((now) => now.map((item) => (item.key === key ? { ...item, ...change } : item)));
  const add = (files: File[]) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      if (preview) previews.current.add(preview);
      setPending((now) => [...now, { key, file, preview, saved: null, error: null }]);
      apiUpload(
        `/sessions/${sessionId}/attachments?name=${encodeURIComponent(file.name || 'pasted')}`,
        file,
        saved,
      ).then(
        (body) => update(key, { saved: body.data }),
        (failure: unknown) => update(key, { error: failure instanceof Error ? failure.message : String(failure) }),
      );
    }
  };
  const remove = (key: string) => setPending((now) => now.filter((item) => item.key !== key));
  return {
    pending,
    ready: pending.flatMap((item) => (item.saved ? [item.saved] : [])),
    uploading: pending.some((item) => item.saved === null && item.error === null),
    add,
    remove,
    clear: () => setPending([]),
  };
}

/** Files in a drag or a paste; empty when it carries only text. */
export const filesIn = (data: DataTransfer | null) => Array.from(data?.files ?? []);

/** The chips of the files attached so far, each with its thumbnail or name, size and a remove button. */
export function AttachmentChips({ pending, onRemove }: { pending: Pending[]; onRemove: (key: string) => void }) {
  if (pending.length === 0) return null;
  return (
    <ul aria-label="Attached files" className="m-0 flex list-none flex-wrap gap-1.5 px-3 pt-3 pb-0">
      {pending.map((item) => (
        <li
          key={item.key}
          title={item.error ?? (item.saved ? item.saved.path : 'Uploading…')}
          className={`flex max-w-64 items-center gap-2 rounded-md border bg-bg py-1 pr-1 pl-1.5 text-xs ${item.error ? 'border-accent-300 text-accent-700' : 'border-line text-text'}`}
        >
          {item.preview ? (
            <img src={item.preview} alt="" className="size-7 flex-none rounded-sm object-cover" />
          ) : (
            <PaperClip />
          )}
          <span className="min-w-0 flex-1 truncate">{item.file.name || 'pasted'}</span>
          <span className="flex-none font-mono text-[10px] text-neutral-700">
            {item.error ? 'failed' : item.saved ? size(item.saved.size) : 'uploading…'}
          </span>
          <button
            type="button"
            aria-label={`Remove ${item.file.name || 'pasted'}`}
            onClick={() => onRemove(item.key)}
            className="flex size-5 flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-neutral-700 hover:bg-neutral-200 hover:text-text"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Opens the file picker; the picked files go to `onFiles`. */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        aria-label="Attach files"
        title="Attach files: images, logs, PDFs. You can also drop them on the box or paste them."
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="flex size-7.5 flex-none cursor-pointer items-center justify-center rounded-full border border-line bg-card text-neutral-700 hover:border-accent-300 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
      >
        <PaperClip />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
    </>
  );
}

function PaperClip() {
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
