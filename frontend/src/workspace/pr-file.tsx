import { GitHost, type PrFile, type PullRequestDetail } from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { DiffLines, DiffStat, FullFileDiff, type LineComments, SplitDiff } from '../components/ui/diff';
import { usePostComment, usePrFile } from '../lib/queries';
import { useStored } from '../lib/remember';
import { CommentComposer, Thread } from './pr-thread';

const VIEWED_KEY = 'ops-console-pr-viewed';

/** A short fingerprint of a file's patch: a file marked viewed reads unviewed again once its change changes. */
function patchHash(file: PrFile): string {
  let hash = 5381;
  for (const line of file.lines) {
    const text = `${line.sign}${line.text}\n`;
    for (let index = 0; index < text.length; index++) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

type Viewed = Record<string, Record<string, string>>;

function readViewed(): Viewed {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(VIEWED_KEY) ?? '{}');
    return value !== null && typeof value === 'object' ? (value as Viewed) : {};
  } catch {
    return {};
  }
}

/** The files of one pull request the operator marked viewed, kept across reloads in this browser. */
export function useViewed(pr: PullRequestDetail) {
  const key = `${pr.repo_id}#${pr.number}`;
  const [all, setAll] = useState(readViewed);
  const marks = all[key] ?? {};
  const isViewed = (file: PrFile) => marks[file.name] === patchHash(file);
  const set = (file: PrFile, viewed: boolean) => {
    const next = { ...readViewed() };
    const files = { ...(next[key] ?? {}) };
    if (viewed) files[file.name] = patchHash(file);
    else delete files[file.name];
    next[key] = files;
    localStorage.setItem(VIEWED_KEY, JSON.stringify(next));
    setAll(next);
  };
  return { isViewed, set, count: pr.files.filter(isViewed).length };
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** The file at the pull request's head commit on its Git host. */
export function sourceUrl(pr: PullRequestDetail, path: string): string {
  const file = encodePath(path);
  if (pr.host === GitHost.Bitbucket) {
    return `${pr.url.replace(/\/pull-requests\/\d+.*$/, '')}/src/${pr.head_sha}/${file}`;
  }
  if (pr.host === GitHost.Gitlab) {
    return `${pr.url.replace(/\/-\/merge_requests\/\d+.*$/, '')}/-/blob/${pr.head_sha}/${file}`;
  }
  return `${pr.url.replace(/\/pull\/\d+.*$/, '')}/blob/${pr.head_sha}/${file}`;
}

/** The file's ⋯ menu: how the change reads, and the file on the host. */
function FileMenu(props: {
  name: string;
  split: boolean;
  full: boolean;
  source: string;
  onSplit: () => void;
  onFull: () => void;
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
  const entry =
    'block w-full cursor-pointer border-0 bg-transparent px-3 py-1.5 text-left font-body text-[13px] text-text no-underline hover:bg-neutral-200';
  const pick = (action: () => void) => () => {
    action();
    setOpen(false);
  };
  return (
    <div ref={box} className="relative flex-none">
      <button
        type="button"
        aria-label={`More for ${props.name}`}
        title="Side by side, the whole file, or the file on the Git host"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex size-6.5 cursor-pointer items-center justify-center rounded-md border text-sm leading-none ${open ? 'border-accent-400 bg-accent-100 text-text' : 'border-divider bg-card text-neutral-700 hover:text-text'}`}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-20 mt-1 w-48 overflow-hidden rounded-lg border border-divider bg-card py-1 shadow-lg"
        >
          <button type="button" role="menuitem" className={entry} onClick={pick(props.onSplit)}>
            {props.split ? 'View unified' : 'View side-by-side'}
          </button>
          <button type="button" role="menuitem" className={entry} onClick={pick(props.onFull)}>
            {props.full ? 'View changes only' : 'View entire file'}
          </button>
          <a
            role="menuitem"
            href={props.source}
            target="_blank"
            rel="noreferrer"
            className={entry}
            onClick={() => setOpen(false)}
          >
            Open in source ↗
          </a>
        </div>
      )}
    </div>
  );
}

/** One changed file: fold it, mark it viewed (which folds it), or read it side by side or whole. */
export function PrFileView({
  pr,
  file,
  viewed,
  onViewed,
}: {
  pr: PullRequestDetail;
  file: PrFile;
  viewed: boolean;
  onViewed: (viewed: boolean) => void;
}) {
  const at = `${pr.repo_id}#${pr.number}.${file.name}`;
  const [open, setOpen] = useStored(`workspace.pr-file-open.${at}`, z.boolean(), !viewed);
  const [split, setSplit] = useStored(`workspace.pr-file-split.${at}`, z.boolean(), false);
  const [full, setFull] = useStored(`workspace.pr-file-full.${at}`, z.boolean(), false);
  const whole = usePrFile(pr.repo_id, pr.number, file.name, pr.head_sha, full);
  const post = usePostComment(pr.repo_id, pr.number);
  /** The new-side line with an open comment box, if any. */
  const [drafting, setDrafting] = useStored(`workspace.pr-drafting.${at}`, z.number().int().nullable(), null);
  const roots = pr.comments.filter(
    (comment) => comment.parent_id === null && comment.file_path === file.name && comment.line !== null,
  );
  const lineComments: LineComments = {
    onAdd: (line) => {
      post.reset();
      setDrafting(line);
    },
    below: (line) => {
      const here = roots.filter((root) => root.line === line);
      if (here.length === 0 && drafting !== line) return null;
      return (
        <>
          {here.map((root) => (
            <Thread key={root.id} pr={pr} root={root} showPlace={false} />
          ))}
          {drafting === line && (
            <CommentComposer
              label={`Comment on ${file.name} line ${line}`}
              draft={`${at}.line.${line}`}
              placeholder={`Comment on line ${line}`}
              submitLabel="Add comment"
              pending={post.isPending}
              error={post.error}
              autoFocus
              onCancel={() => setDrafting(null)}
              onSubmit={(body, done) =>
                post.mutate(
                  { body, file_path: file.name, line },
                  {
                    onSuccess: () => {
                      done();
                      setDrafting(null);
                    },
                  },
                )
              }
            />
          )}
        </>
      );
    },
  };
  const mark = (next: boolean) => {
    onViewed(next);
    setOpen(!next);
  };

  return (
    <section aria-label={file.name} className="overflow-hidden rounded-md border border-divider bg-card">
      <div
        className={`flex items-center gap-2 bg-surface px-2 py-1 font-mono text-xs ${open ? 'border-b border-divider' : ''}`}
      >
        <button
          type="button"
          aria-expanded={open}
          title={open ? 'Fold this file' : 'Show the change in this file'}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-1 py-1 text-left font-mono text-xs text-text"
        >
          <span aria-hidden className={`text-[9px] text-neutral-600 transition-transform ${open ? 'rotate-90' : ''}`}>
            ▶
          </span>
          <span className={`min-w-0 truncate font-semibold ${viewed ? 'text-neutral-700' : ''}`}>{file.name}</span>
        </button>
        {roots.length > 0 && (
          <span
            title={`${roots.length} comment ${roots.length === 1 ? 'thread' : 'threads'} on lines of this file. Open the file to read them.`}
            className="flex flex-none items-center gap-1 rounded-full bg-diff-hunk px-1.75 py-px font-body text-[11px] font-semibold text-diff-hunk-text"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
              <path
                d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
            {roots.length}
          </span>
        )}
        <DiffStat additions={file.additions} deletions={file.deletions} />
        <label
          title="Tick when you have read this file. It folds, and stays ticked in this browser until its change changes."
          className={`flex flex-none cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 font-body text-xs ${viewed ? 'border-ok/40 bg-ok/10 text-ok' : 'border-divider bg-card text-neutral-700 hover:text-text'}`}
        >
          <input
            type="checkbox"
            checked={viewed}
            onChange={(event) => mark(event.target.checked)}
            className="m-0 size-3.5 cursor-pointer accent-[var(--color-ok)]"
          />
          Viewed
        </label>
        <FileMenu
          name={file.name}
          split={split}
          full={full}
          source={sourceUrl(pr, file.name)}
          onSplit={() => {
            setSplit(!split);
            setFull(false);
            setOpen(true);
          }}
          onFull={() => {
            setFull(!full);
            setSplit(false);
            setOpen(true);
          }}
        />
      </div>
      {open &&
        (file.lines.length === 0 ? (
          <div className="px-3 py-2 text-xs text-neutral-700">No text diff: binary, renamed or too large.</div>
        ) : full ? (
          whole.isPending ? (
            <div className="px-3 py-2 text-xs text-neutral-700">Reading the whole file…</div>
          ) : whole.isError ? (
            <div role="alert" className="px-3 py-2 text-xs text-accent-700">
              Could not read the file: {whole.error.message}
            </div>
          ) : whole.data.text === null ? (
            <div className="px-3 py-2 text-xs text-neutral-700">The file is deleted at this commit.</div>
          ) : (
            <FullFileDiff lines={file.lines} text={whole.data.text} />
          )
        ) : split ? (
          <SplitDiff lines={file.lines} />
        ) : (
          <DiffLines lines={file.lines} comments={lineComments} />
        ))}
    </section>
  );
}
