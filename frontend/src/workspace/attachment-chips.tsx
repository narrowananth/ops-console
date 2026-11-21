import { fileSize, PASTED_TEXT_NAME } from '@ops-console/shared';
import { FileKindIcon, kindOf } from '../components/ui/file-kind';
import type { FileItem } from './attachments';

/** The state a chip shows for a file: its size once known, or that it is on its way, or why it failed. */
function sizeOf(item: FileItem): string {
  if (item.saved) return fileSize(item.saved.size);
  if (item.file) return item.error ? '' : `${fileSize(item.file.size)} · uploading…`;
  return '';
}

/**
 * The files attached to the message being written, one chip each above the text: a picture or the video's first frame,
 * else an icon for its kind, with its name and size and a way to take it out. A chip opens its file; pasted text shows
 * as a card with its first lines.
 */
export function AttachmentChips({
  items,
  onOpen,
  onEdit,
  onRemove,
}: {
  items: FileItem[];
  onOpen: (name: string) => void;
  /** The pencil on a pasted text card. */
  onEdit: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul
      aria-label="Files to send"
      className="m-0 flex max-h-44 list-none flex-wrap gap-2 overflow-y-auto px-3.5 pt-3 pb-0"
    >
      {items.map((item) => {
        const { name, error } = item;
        const kind = kindOf(name);
        const remove = (
          <button
            type="button"
            aria-label={`Remove ${name}`}
            title={`Remove ${name}`}
            onClick={() => onRemove(name)}
            className="flex size-6 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-base leading-none text-neutral-700 hover:bg-neutral-200 hover:text-text"
          >
            ×
          </button>
        );
        if (PASTED_TEXT_NAME.test(name)) {
          return (
            <li
              key={name}
              data-file={name}
              data-kind="text"
              className={`group flex h-32 w-44 flex-col justify-between rounded-xl border bg-bg p-2.5 text-xs ${error ? 'border-accent-300' : 'border-line'}`}
            >
              <button
                type="button"
                title={error ?? `Open ${name}`}
                onClick={() => onOpen(name)}
                className="line-clamp-5 cursor-pointer border-0 bg-transparent p-0 text-left font-mono text-[11px] leading-4 break-all text-neutral-700"
              >
                {item.snippet || name}
              </button>
              <span className="flex items-center justify-between gap-2">
                <span className="rounded-md border border-line px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-neutral-700 uppercase">
                  Pasted
                </span>
                <span className="flex items-center gap-1">
                  <span className="text-[11px] text-neutral-700">{error ? 'failed' : sizeOf(item)}</span>
                  <button
                    type="button"
                    aria-label={`Edit ${name}`}
                    title={`Edit ${name}`}
                    onClick={() => onEdit(name)}
                    className="flex size-7 cursor-pointer items-center justify-center rounded-md border border-line bg-card p-0 text-neutral-700 hover:border-accent-300 hover:text-text"
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
                      <path
                        d="M11 2.5 13.5 5 5.5 13 2.5 13.5 3 10.5 11 2.5Z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {remove}
                </span>
              </span>
            </li>
          );
        }
        return (
          <li
            key={name}
            data-file={name}
            data-kind={kind}
            className={`flex max-w-64 min-w-0 items-center gap-2 rounded-xl border bg-bg py-1 pr-1 pl-1 ${error ? 'border-accent-300' : 'border-line'}`}
          >
            <button
              type="button"
              title={error ?? `Open ${name}`}
              onClick={() => onOpen(name)}
              className="flex min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-text"
            >
              <span className="flex size-10 flex-none items-center justify-center overflow-hidden rounded-lg bg-neutral-200 text-neutral-700">
                {item.preview ? (
                  <img src={item.preview} alt="" className="size-full object-cover" />
                ) : (
                  <FileKindIcon kind={kind} size={20} />
                )}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] leading-5">{name}</span>
                <span className={`truncate text-[11px] leading-4 ${error ? 'text-accent-700' : 'text-neutral-700'}`}>
                  {error ?? sizeOf(item)}
                </span>
              </span>
            </button>
            {remove}
          </li>
        );
      })}
    </ul>
  );
}
