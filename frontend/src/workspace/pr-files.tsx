import type { PrFile, PullRequestDetail } from '@ops-console/shared';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { DiffStat } from '../components/ui/diff';
import { useStored } from '../lib/remember';
import { ago } from '../monitor/scan-scope';
import { PrFileView, type useViewed } from './pr-file';
import { firstLine } from './pr-jobs';
import { Avatar } from './pr-meta';
import { FileSort, fileTree, isOutdated, sortedFiles, type ThreadData, threadsOf } from './pr-threads';

const FOLD_ALL =
  'cursor-pointer whitespace-nowrap rounded border-0 bg-transparent px-1.5 py-0.5 text-xs text-neutral-700 hover:bg-neutral-200 hover:text-text';

const SORT_LABEL: Record<FileSort, string> = { [FileSort.Tree]: 'File tree', [FileSort.Recent]: 'Recent comments' };

/** A button that opens a menu under it; a click outside or Escape closes it. */
function Dropdown({
  label,
  title,
  width,
  children,
}: {
  label: string;
  title: string;
  width: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div ref={box} className="relative flex-none">
      <button
        type="button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs text-text ${open ? 'border-accent-400 bg-accent-100' : 'border-divider bg-card hover:border-neutral-400'}`}
      >
        {label}
        <span aria-hidden className="text-neutral-600">
          ▾
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute top-full z-30 mt-1 max-h-[70vh] overflow-y-auto rounded-lg border border-divider bg-card shadow-lg left-0 ${width}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** One section of the Comments menu: a header with its count that folds, then a row per thread. */
function CommentsSection({
  title,
  threads,
  files,
  onPick,
  folded,
  onFold,
}: {
  title: string;
  threads: ThreadData[];
  files: PrFile[];
  onPick: (thread: ThreadData) => void;
  folded: boolean;
  onFold: () => void;
}) {
  return (
    <section aria-label={title}>
      <button
        type="button"
        aria-expanded={!folded}
        onClick={onFold}
        className="flex w-full cursor-pointer items-center border-0 border-b border-line bg-surface px-3.5 py-2 text-left text-[13px] font-semibold text-neutral-700"
      >
        {title}
        <span className="ml-auto font-mono text-[11px] font-normal">
          {threads.length} {folded ? '▾' : '▴'}
        </span>
      </button>
      {!folded && threads.length === 0 && <div className="px-3.5 py-2 text-xs text-neutral-600">None.</div>}
      {!folded &&
        threads.map((thread) => (
          <button
            key={thread.root.id}
            type="button"
            role="menuitem"
            onClick={() => onPick(thread)}
            className="flex w-full cursor-pointer flex-col gap-0.5 border-0 border-b border-line bg-transparent px-3.5 py-2 text-left text-[13px] text-text hover:bg-neutral-200"
          >
            <span className="flex items-center gap-2">
              <Avatar name={thread.root.author} size="sm" />
              <strong className="font-semibold">{thread.root.author}</strong>
              {isOutdated(files, thread.root) && (
                <span className="rounded-full bg-warn/15 px-2 py-px text-xs font-semibold text-warn">Outdated</span>
              )}
              <span className="min-w-0 truncate text-xs text-neutral-600">
                {ago(thread.root.created_at)} on {thread.root.file_path?.split('/').at(-1)}
              </span>
            </span>
            <span className="truncate text-xs text-neutral-600">{firstLine(thread.root.body)}</span>
          </button>
        ))}
    </section>
  );
}

function CommentsMenu({
  pr,
  threads,
  onPick,
}: {
  pr: PullRequestDetail;
  threads: ThreadData[];
  onPick: (thread: ThreadData) => void;
}) {
  const [unresolvedFolded, setUnresolvedFolded] = useState(false);
  const [resolvedFolded, setResolvedFolded] = useState(true);
  const pick = (close: () => void) => (thread: ThreadData) => {
    close();
    onPick(thread);
  };
  const inline = threads.filter((thread) => thread.root.file_path !== null);
  const unresolved = inline.filter((thread) => !thread.root.resolved);
  const resolved = inline.filter((thread) => thread.root.resolved);
  return (
    <Dropdown
      label={`Comments (${unresolved.length} unresolved)`}
      title="Every comment on a line or a file. A click jumps to its thread in the diff."
      width="w-96"
    >
      {(close) => (
        <>
          <CommentsSection
            title="Unresolved Comments"
            threads={unresolved}
            files={pr.files}
            folded={unresolvedFolded}
            onFold={() => setUnresolvedFolded(!unresolvedFolded)}
            onPick={pick(close)}
          />
          <CommentsSection
            title="Resolved Comments"
            threads={resolved}
            files={pr.files}
            folded={resolvedFolded}
            onFold={() => setResolvedFolded(!resolvedFolded)}
            onPick={pick(close)}
          />
        </>
      )}
    </Dropdown>
  );
}

/** The files, as folders and files or as the flat list a Sort by Recent comments gives, each with its +/− and open threads. */
function FileTree({
  pr,
  sort,
  active,
  onPick,
  onFold,
}: {
  pr: PullRequestDetail;
  sort: FileSort;
  active: string | null;
  onPick: (file: PrFile) => void;
  onFold: () => void;
}) {
  const unresolved = (name: string) =>
    pr.comments.filter((comment) => comment.parent_id === null && !comment.resolved && comment.file_path === name)
      .length;
  const entries =
    sort === FileSort.Tree
      ? fileTree(pr.files)
      : sortedFiles(pr, sort).map((file) => ({ kind: 'file' as const, file, name: file.name, depth: 0 }));
  return (
    <nav aria-label="Files in this pull request" className="flex w-68 flex-none flex-col border-r border-line">
      <div className="flex items-center px-2.5 pt-2 pb-1 text-[11px] tracking-wider text-neutral-600 uppercase">
        Files
        <button
          type="button"
          aria-label="Fold the file tree"
          title="Fold the tree to a strip"
          onClick={onFold}
          className="ml-auto cursor-pointer rounded border-0 bg-transparent px-1.5 text-sm text-neutral-700 hover:bg-neutral-200"
        >
          ‹
        </button>
      </div>
      <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1.5 pb-3 text-[12.5px]">
        {entries.map((entry) =>
          entry.kind === 'folder' ? (
            <li
              key={entry.path}
              style={{ ...guides(entry.depth), paddingLeft: 8 + entry.depth * 14 }}
              className="flex items-center gap-1 truncate py-1 text-neutral-600"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="flex-none">
                <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              <span className="truncate">{entry.name}</span>
            </li>
          ) : (
            <li key={entry.file.name} style={guides(entry.depth)} className="flow-root">
              <button
                type="button"
                aria-current={active === entry.file.name}
                title={entry.file.name}
                onClick={() => onPick(entry.file)}
                style={{ paddingLeft: 8 + entry.depth * 14 }}
                className={`my-0.5 flex w-full cursor-pointer items-center gap-1.5 rounded-md border-0 py-0.5 pr-2 text-left text-[12.5px] text-text ${active === entry.file.name ? 'bg-card font-semibold shadow-sm' : 'bg-transparent hover:bg-neutral-200'}`}
              >
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {unresolved(entry.file.name) > 0 && (
                  <span
                    title={`${unresolved(entry.file.name)} unresolved ${unresolved(entry.file.name) === 1 ? 'thread' : 'threads'}`}
                    className="rounded-full bg-accent-200 px-1.5 font-mono text-[10px] font-semibold text-accent-900"
                  >
                    {unresolved(entry.file.name)}
                  </span>
                )}
                <span className="flex flex-none gap-1 font-mono text-[11px]">
                  <span className="text-diff-add-text">+{entry.file.additions}</span>
                  <span className="text-diff-del-text">−{entry.file.deletions}</span>
                </span>
              </button>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

/**
 * A vertical guide line for each level of folder above a row, under the middle of that folder's chevron. The rows
 * stay flush, so the lines run unbroken down the tree while the buttons inside them keep their gap.
 */
function guides(depth: number): CSSProperties {
  if (depth === 0) return {};
  return {
    backgroundImage: 'repeating-linear-gradient(90deg, var(--color-divider) 0 1px, transparent 1px 14px)',
    backgroundSize: `${depth * 14}px 100%`,
    backgroundPosition: '12px 0',
    backgroundRepeat: 'no-repeat',
  };
}

/**
 * Files changed: a bar with the Comments and Sort menus, Expand all, Collapse all and the viewed count; a file tree on
 * the left, which folds to a strip; and the files' diffs.
 */
export function PrFiles({ pr, viewed }: { pr: PullRequestDetail; viewed: ReturnType<typeof useViewed> }) {
  const here = `${pr.repo_id}#${pr.number}`;
  const [sort, setSort] = useStored('workspace.pr-files-sort', z.enum(FileSort), FileSort.Tree);
  const [treeFolded, setTreeFolded] = useStored('workspace.pr-tree-folded', z.boolean(), false);
  const [active, setActive] = useState<string | null>(null);
  // Expand all or Collapse all, for this pull request only: another one opens with each file as it was left.
  const [fold, setFold] = useState<{ pr: string; open: boolean } | null>(null);
  const bulk = fold?.pr === here ? fold : null;
  const [reveal, setReveal] = useState<{ file: string; thread: string } | null>(null);
  const threads = threadsOf(pr);
  const files = sortedFiles(pr, sort);
  const scrollTo = (name: string) =>
    document.querySelector(`section[aria-label="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'start' });
  return (
    <div role="tabpanel" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-line px-6 py-2 text-xs text-neutral-700">
        <CommentsMenu
          pr={pr}
          threads={threads}
          onPick={(thread) => {
            const file = thread.root.file_path;
            if (file === null) return;
            setActive(file);
            setReveal({ file, thread: thread.root.id });
          }}
        />
        <Dropdown label={`Sort by ${SORT_LABEL[sort]}`} title="How the tree and the diffs are ordered" width="w-48">
          {(close) =>
            Object.values(FileSort).map((value) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={sort === value}
                onClick={() => {
                  setSort(value);
                  close();
                }}
                className={`block w-full cursor-pointer border-0 border-b border-line px-3.5 py-2 text-left text-[13px] text-text ${sort === value ? 'bg-accent-100 font-semibold' : 'bg-transparent hover:bg-neutral-200'}`}
              >
                {SORT_LABEL[value]}
              </button>
            ))
          }
        </Dropdown>
        <DiffStat
          additions={pr.files.reduce((sum, file) => sum + file.additions, 0)}
          deletions={pr.files.reduce((sum, file) => sum + file.deletions, 0)}
        />
        {pr.files.length > 1 && (
          <span className="flex items-center gap-1">
            <button
              type="button"
              title="Open every file on its lines"
              onClick={() => setFold({ pr: here, open: true })}
              className={FOLD_ALL}
            >
              Expand all
            </button>
            <button
              type="button"
              title="Fold every file to its name, to get to the comments and the end of the page"
              onClick={() => setFold({ pr: here, open: false })}
              className={FOLD_ALL}
            >
              Collapse all
            </button>
          </span>
        )}
        {pr.files.length > 0 && (
          <span
            title="Files you ticked Viewed, kept in this browser. A file whose change changes reads unviewed again."
            className="ml-auto flex items-center gap-2 whitespace-nowrap"
          >
            <span className={viewed.count === pr.files.length ? 'font-semibold text-ok' : ''}>
              {viewed.count} / {pr.files.length} viewed
            </span>
            <span aria-hidden className="h-1.5 w-20 overflow-hidden rounded-full bg-neutral-300">
              <span
                className="block h-full rounded-full bg-ok transition-[width]"
                style={{ width: `${(viewed.count / pr.files.length) * 100}%` }}
              />
            </span>
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        {pr.files.length > 0 &&
          (treeFolded ? (
            <button
              type="button"
              aria-label="Open the file tree"
              title="Open the file tree"
              onClick={() => setTreeFolded(false)}
              className="w-7 flex-none cursor-pointer border-0 border-r border-line bg-transparent text-sm text-neutral-700 hover:bg-neutral-200"
            >
              ›
            </button>
          ) : (
            <FileTree
              pr={pr}
              sort={sort}
              active={active}
              onFold={() => setTreeFolded(true)}
              onPick={(file) => {
                setActive(file.name);
                scrollTo(file.name);
              }}
            />
          ))}
        <section
          aria-label="Files"
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto px-5 py-4 [&>*]:shrink-0"
        >
          {pr.files.length === 0 && <p className="m-0 text-[13px] text-neutral-700">No files changed.</p>}
          {files.map((file) => (
            <PrFileView
              key={`${pr.head_sha}:${file.name}`}
              pr={pr}
              file={file}
              viewed={viewed.isViewed(file)}
              onViewed={(next) => viewed.set(file, next)}
              bulk={bulk}
              reveal={reveal}
            />
          ))}
        </section>
      </div>
    </div>
  );
}
