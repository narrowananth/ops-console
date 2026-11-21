import { useId, useState } from 'react';
import { DiffLines } from '../components/ui/diff';

type Line = { sign: '+' | '-' | ' '; text: string };

/** How much of the name stays whole at its end, so the extension survives a narrow row. */
const KEEP = 10;

/** `Wrote` for a change with no removed line: the agent's Write, or an Edit that only adds. Anything else is `Edited`. */
export function changeVerb(lines: Line[]): 'Wrote' | 'Edited' {
  return lines.some((line) => line.sign === '-') ? 'Edited' : 'Wrote';
}

function badge(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1, dot + 5).toUpperCase() : 'FILE';
}

/**
 * A file the agent wrote or edited, folded to one row: type, name, verb and line counts. The diff is not drawn until
 * the operator opens it, so a large Write costs nothing in a long conversation.
 */
export function FileChange({ file, lines }: { file: string; lines: Line[] }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const name = file.split('/').filter(Boolean).at(-1) ?? file;
  const added = lines.filter((line) => line.sign === '+').length;
  const removed = lines.filter((line) => line.sign === '-').length;
  const cut = Math.max(0, name.length - KEEP);
  return (
    <div className="overflow-hidden rounded-md border border-line font-mono text-xs">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        // The name sits in two spans so it can shorten in the middle; a label keeps it one word for a screen reader.
        aria-label={`${changeVerb(lines)} ${name}, ${added} added, ${removed} removed`}
        onClick={() => setOpen((now) => !now)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 border-0 bg-surface px-2 py-1.5 text-left font-[inherit] text-text outline-none hover:bg-neutral-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden
          className={`flex-none text-neutral-600 transition-transform ${open ? '' : '-rotate-90'}`}
        >
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="flex-none rounded-sm border border-line bg-card px-1 text-[10px] leading-4 font-semibold text-neutral-700">
          {badge(name)}
        </span>
        <span title={file} className="flex min-w-0 font-semibold">
          <span className="min-w-0 truncate">{name.slice(0, cut)}</span>
          <span className="flex-none">{name.slice(cut)}</span>
        </span>
        <span className="flex-none text-neutral-700">{changeVerb(lines)}</span>
        <span className="ml-auto flex flex-none gap-1.5 font-semibold">
          <span className="text-diff-add-text">+{added}</span>
          <span className="text-diff-del-text">−{removed}</span>
        </span>
      </button>
      {open && (
        <div id={panel} className="max-h-[60vh] overflow-y-auto border-t border-line">
          <DiffLines lines={lines} />
        </div>
      )}
    </div>
  );
}
