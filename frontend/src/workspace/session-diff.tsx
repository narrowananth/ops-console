import { type SessionDiff, type SessionDiffFile, SessionDiffStatus } from '@ops-console/shared';
import { useState } from 'react';
import { z } from 'zod';
import { Button } from '../components/ui/button';
import { DiffLines, DiffStat, SplitDiff } from '../components/ui/diff';
import { useStored } from '../lib/remember';

/** The diff panel's size: its width when the operator has not dragged it, its narrowest, and the room the conversation keeps. */
export const DIFF_PANEL = { key: 'workspace.session-diff-width', initial: 560, narrowest: 320, keep: 360 };
/** Files open at first while the diff has this many or fewer. */
const OPEN_UP_TO = 8;

const STATUS: Record<SessionDiffStatus, { letter: string; tone: string; word: string }> = {
  [SessionDiffStatus.Added]: { letter: 'A', tone: 'text-diff-add-text', word: 'added' },
  [SessionDiffStatus.Modified]: { letter: 'M', tone: 'text-warn', word: 'modified' },
  [SessionDiffStatus.Deleted]: { letter: 'D', tone: 'text-diff-del-text', word: 'deleted' },
  [SessionDiffStatus.Renamed]: { letter: 'R', tone: 'text-diff-hunk-text', word: 'renamed' },
};

/**
 * What the Session's branch changes, file by file, beside the conversation: the branch against where it forked, the
 * totals, and each file folded to its path or open on its lines.
 */
export function DiffPanel({
  diff,
  error,
  loading,
  fetching,
  onRefresh,
  onClose,
}: {
  diff: SessionDiff | undefined;
  error: string | null;
  loading: boolean;
  fetching: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [split, setSplit] = useStored('workspace.session-diff-split', z.boolean(), false);
  // Files the operator opened or closed; the rest follow the default for the diff's size.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [allOpen, setAllOpen] = useState<boolean | null>(null);
  const files = diff?.files ?? [];
  const openByDefault = allOpen ?? files.length <= OPEN_UP_TO;
  const isOpen = (file: SessionDiffFile) => toggled[file.name] ?? openByDefault;

  return (
    <aside aria-label="Diff" className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <h3 className="m-0 text-sm font-semibold">Changes</h3>
        {diff && (
          <span
            className="min-w-0 truncate font-mono text-xs text-neutral-700"
            title="The branch, and what it is compared with"
          >
            {diff.branch ?? 'detached HEAD'}
            {diff.base && ` → ${diff.base}`}
          </span>
        )}
        {diff && files.length > 0 && <DiffStat additions={diff.additions} deletions={diff.deletions} />}
        <span className="ml-auto flex items-center gap-1">
          {files.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => {
                  setToggled({});
                  setAllOpen(!openByDefault);
                }}
                className={TOOL}
              >
                {openByDefault ? 'Collapse all' : 'Expand all'}
              </button>
              <button
                type="button"
                aria-pressed={split}
                title={split ? 'Show each file as one column' : 'Show the old and new file side by side'}
                onClick={() => setSplit((now) => !now)}
                className={TOOL}
              >
                {split ? 'Unified' : 'Split'}
              </button>
            </>
          )}
          <button
            type="button"
            title="Read the diff from the Repo again"
            disabled={fetching}
            onClick={onRefresh}
            className={TOOL}
          >
            {fetching ? 'Reading…' : 'Refresh'}
          </button>
          <button type="button" aria-label="Close the diff" title="Close" onClick={onClose} className={TOOL}>
            ×
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <p className="m-0 px-1 text-xs text-neutral-700">Reading the changes…</p>
        ) : error ? (
          <p role="alert" className="m-0 px-1 text-xs text-accent-700">
            Could not read the changes: {error}
          </p>
        ) : files.length === 0 ? (
          <p className="m-0 px-1 text-xs text-neutral-700">
            No changes on {diff?.branch ?? 'this branch'}
            {diff?.base ? ` against ${diff.base}` : ''}.
          </p>
        ) : (
          <>
            <p className="m-0 mb-2 px-1 text-xs text-neutral-700">
              {files.length} changed {files.length === 1 ? 'file' : 'files'}
            </p>
            <ul aria-label="Changed files" className="m-0 flex list-none flex-col gap-2 p-0">
              {files.map((file) => (
                <FileDiff
                  key={file.name}
                  file={file}
                  open={isOpen(file)}
                  split={split}
                  onToggle={() => setToggled((now) => ({ ...now, [file.name]: !isOpen(file) }))}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}

function FileDiff({
  file,
  open,
  split,
  onToggle,
}: {
  file: SessionDiffFile;
  open: boolean;
  split: boolean;
  onToggle: () => void;
}) {
  const status = STATUS[file.status];
  const slash = file.name.lastIndexOf('/');
  const folder = slash === -1 ? '' : file.name.slice(0, slash + 1);
  const base = file.name.slice(slash + 1);
  const changed = file.lines.some((line) => line.sign !== ' ');
  return (
    <li className="overflow-hidden rounded-md border border-line bg-card">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${file.name}, ${status.word}`}
        title={file.old_name ? `${file.old_name} → ${file.name}` : file.name}
        onClick={onToggle}
        className="sticky top-0 flex w-full cursor-pointer items-center gap-2 border-0 bg-card px-2.5 py-1.5 text-left hover:bg-neutral-200"
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
        <span aria-hidden className={`w-3 flex-none font-mono text-xs font-semibold ${status.tone}`}>
          {status.letter}
        </span>
        <span className="flex min-w-0 flex-1 truncate font-mono text-xs">
          <span className="truncate text-neutral-700">{folder}</span>
          <span className="flex-none text-text">{base}</span>
        </span>
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </button>
      {open && (
        <div className="border-t border-line">
          {file.binary ? (
            <Note>Binary file, not shown.</Note>
          ) : !changed && file.lines.length === 0 ? (
            <Note>
              {file.status === SessionDiffStatus.Renamed
                ? `Renamed from ${file.old_name}, no change inside.`
                : file.truncated
                  ? 'Too big to show.'
                  : 'Empty file.'}
            </Note>
          ) : split ? (
            <SplitDiff lines={file.lines} />
          ) : (
            <DiffLines lines={file.lines} />
          )}
          {file.truncated && file.lines.length > 0 && (
            <Note>Cut here: the rest of this file's changes are not shown.</Note>
          )}
        </div>
      )}
    </li>
  );
}

function Note({ children }: { children: string }) {
  return <p className="m-0 px-3 py-2 text-xs text-neutral-700">{children}</p>;
}

/** The header button that opens and closes the diff, with the totals once read. */
export function DiffToggle({
  open,
  diff,
  onToggle,
}: {
  open: boolean;
  diff: SessionDiff | undefined;
  onToggle: () => void;
}) {
  const files = diff?.files.length ?? 0;
  return (
    <Button
      aria-pressed={open}
      title={open ? 'Close the diff' : "Show what this Session's branch changes"}
      className={`px-2.5 py-1 text-xs ${open ? 'border-accent-300 bg-accent-100' : ''}`}
      onClick={onToggle}
    >
      Diff
      {diff && files > 0 && (
        <span className="font-mono font-semibold">
          <span className="text-diff-add-text">+{diff.additions}</span>{' '}
          <span className="text-diff-del-text">−{diff.deletions}</span>
        </span>
      )}
    </Button>
  );
}

const TOOL =
  'cursor-pointer rounded-md border-0 bg-transparent px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-200 hover:text-text disabled:cursor-default disabled:opacity-60';
