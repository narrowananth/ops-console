import { type Attachment, attachmentSchema, PASTED_TEXT_NAME, tokenName } from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { attachmentAddress, PaperClip } from '../components/ui/attachment-viewer';
import { apiBlob, apiUpload } from '../lib/api';
import { useStored } from '../lib/remember';

/** A file in the message being written: uploading, saved, or refused. Its name is unique in the message. */
export type FileItem = {
  name: string;
  /** The file picked, dropped or pasted on this page; null for one kept from before a reload. */
  file: File | null;
  /** A thumbnail for images. */
  preview: string | null;
  /** The first characters of a pasted text file, for its card; null until read. */
  snippet: string | null;
  saved: Attachment | null;
  error: string | null;
};

const savedBody = z.object({ data: attachmentSchema });
/** How many characters of a pasted text a card shows. */
const SNIPPET_CHARS = 180;
const IMAGE = /\.(gif|jpe?g|png|webp)$/i;

/** `name`, or `name (2)` and on, so two files in one message never share a name. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let n = 2;
  while (taken.has(`${stem} (${n})${ext}`)) n++;
  return `${stem} (${n})${ext}`;
}

/**
 * The files attached to the message being written. Each uploads as soon as it is added: picked, dropped or pasted.
 * Saved ones stay with the Session through a reload or a switch, until removed or sent.
 */
export function useAttachments(sessionId: string) {
  const [kept, setKept] = useStored(`workspace.attachments.${sessionId}`, z.array(attachmentSchema), []);
  const [live, setLive] = useState<FileItem[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [snippets, setSnippets] = useState<Record<string, string>>({});
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const made = urls.current;
    return () => {
      for (const url of made) URL.revokeObjectURL(url);
    };
  }, []);

  const items: FileItem[] = [
    ...kept
      .filter((saved) => !live.some((item) => item.name === saved.name))
      .map((saved) => ({
        name: saved.name,
        file: null,
        preview: thumbs[saved.name] || null,
        snippet: null,
        saved,
        error: null,
      })),
    ...live,
  ].map((item) => ({ ...item, snippet: snippets[item.name] ?? null }));

  // Thumbnails for images kept from before a reload, read back from the daemon.
  const missing = kept.filter(
    (saved) => IMAGE.test(saved.name) && !(saved.name in thumbs) && !live.some((item) => item.name === saved.name),
  );
  const missingKey = missing.map((saved) => saved.path).join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key lists the files to read
  useEffect(() => {
    for (const saved of missing) {
      setThumbs((now) => ({ ...now, [saved.name]: '' }));
      apiBlob(attachmentAddress(saved.path)).then(
        (blob) => {
          const url = URL.createObjectURL(blob);
          urls.current.add(url);
          setThumbs((now) => ({ ...now, [saved.name]: url }));
        },
        () => {},
      );
    }
  }, [missingKey]);

  // The first lines of each pasted text file, for its card: read from the file on this page, or back from the daemon.
  const unread = items.filter((item) => PASTED_TEXT_NAME.test(item.name) && !(item.name in snippets));
  const unreadKey = unread.map((item) => item.name).join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key lists the files to read
  useEffect(() => {
    for (const item of unread) {
      setSnippets((now) => ({ ...now, [item.name]: '' }));
      const source = item.file
        ? Promise.resolve<Blob>(item.file)
        : item.saved
          ? apiBlob(attachmentAddress(item.saved.path))
          : null;
      source
        ?.then((blob) => blob.slice(0, SNIPPET_CHARS * 2).text())
        .then(
          (text) =>
            setSnippets((now) => ({ ...now, [item.name]: text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS) })),
          () => {},
        );
    }
  }, [unreadKey]);

  const update = (name: string, change: Partial<FileItem>) =>
    setLive((now) => now.map((item) => (item.name === name ? { ...item, ...change } : item)));

  /** Starts the upload of `file` under `name`; the item in `live` follows it. */
  const upload = (name: string, file: File, preview: string | null) => {
    setLive((now) => [
      ...now.filter((item) => item.name !== name),
      { name, file, preview, snippet: null, saved: null, error: null },
    ]);
    apiUpload(`/sessions/${sessionId}/attachments?name=${encodeURIComponent(name)}`, file, savedBody).then(
      (body) => {
        const saved = { ...body.data, name };
        update(name, { saved });
        setKept((now) => [...now.filter((item) => item.name !== name), saved]);
      },
      (failure: unknown) => update(name, { error: failure instanceof Error ? failure.message : String(failure) }),
    );
  };

  /** Uploads the files and gives back the name each goes under in the message. */
  const add = (files: File[]): string[] => {
    const taken = new Set(items.map((item) => item.name));
    return files.map((file) => {
      const name = uniqueName(tokenName(file.name || 'pasted'), taken);
      taken.add(name);
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      if (preview) urls.current.add(preview);
      upload(name, file, preview);
      return name;
    });
  };

  /** Puts `text` in the pasted text file `name`: the same name in the message, the new text uploaded. */
  const rewrite = (name: string, text: string) => {
    setSnippets((now) => Object.fromEntries(Object.entries(now).filter(([key]) => key !== name)));
    upload(name, new File([text], name, { type: 'text/plain' }), null);
  };

  const remove = (names: string[]) => {
    setLive((now) => now.filter((item) => !names.includes(item.name)));
    setSnippets((now) => Object.fromEntries(Object.entries(now).filter(([name]) => !names.includes(name))));
    setKept((now) => now.filter((item) => !names.includes(item.name)));
  };

  return {
    items,
    find: (name: string) => items.find((item) => item.name === name),
    /** The saved files among `names`, in that order. */
    saved: (names: string[]) =>
      names.flatMap((name) => {
        const item = items.find((candidate) => candidate.name === name);
        return item?.saved ? [item.saved] : [];
      }),
    uploading: (names: string[]) =>
      items.some((item) => names.includes(item.name) && item.saved === null && item.error === null),
    add,
    rewrite,
    remove,
  };
}

/** Files in a drag or a paste; empty when it carries only text. */
export const filesIn = (data: DataTransfer | null) => Array.from(data?.files ?? []);

/** Opens the file picker; the picked files go to `onFiles`. */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        aria-label="Attach files"
        title="Attach files: images, logs, PDFs. They go in the text where the cursor is. You can also drop or paste them."
        disabled={disabled}
        // Keeps the cursor where it is in the message, so the file goes there.
        onMouseDown={(event) => event.preventDefault()}
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
