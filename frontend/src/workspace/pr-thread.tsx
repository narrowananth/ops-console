import { PrAction, type PrComment, type PullRequestDetail } from '@ops-console/shared';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button, Spinner } from '../components/ui/button';
import { Markdown } from '../components/ui/markdown';
import { useDeleteComment, usePostComment, useResolveComment } from '../lib/queries';
import { useStored } from '../lib/remember';
import { ago } from '../monitor/scan-scope';
import { Avatar } from './pr-meta';
import { canCheck, hunkRows, isOutdated } from './pr-threads';

/**
 * A box to write a comment in. ⌘/Ctrl+Enter sends it. `onCancel` adds a Cancel button, for a box opened on a line.
 */
export function CommentComposer(props: {
  label: string;
  /** Where the typed text is kept until it is sent or cancelled, so a reload or a page switch keeps it. */
  draft: string;
  placeholder: string;
  submitLabel: string;
  pending: boolean;
  error: Error | null;
  onSubmit: (body: string, done: () => void) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useStored(`workspace.draft.${props.draft}`, z.string(), '');
  const cancel = () => {
    setBody('');
    props.onCancel?.();
  };
  const submit = () => {
    if (body.trim() === '' || props.pending) return;
    props.onSubmit(body, () => setBody(''));
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-divider bg-card p-2.5 font-body shadow-sm">
      <textarea
        aria-label={props.label}
        value={body}
        rows={3}
        // biome-ignore lint/a11y/noAutofocus: the box opens because the operator asked to write here
        autoFocus={props.autoFocus}
        placeholder={props.placeholder}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
          if (event.key === 'Escape' && props.onCancel) cancel();
        }}
        className="field-sizing-content max-h-[50vh] min-h-24 w-full resize-y overflow-y-auto rounded-md border border-divider bg-bg px-2.5 py-2 font-body text-[13px] leading-relaxed text-text outline-none focus:border-accent-400 focus:shadow-[0_0_0_3px_var(--color-accent-100)]"
      />
      <div className="flex items-center gap-2">
        <span title="Write in Markdown. ⌘Enter or Ctrl+Enter sends." className="text-xs text-neutral-600">
          Markdown · ⌘↵ to send
        </span>
        {props.error && (
          <span role="alert" className="text-xs text-accent-700">
            {props.error.message}
          </span>
        )}
        <span className="ml-auto flex gap-1.5">
          {props.onCancel && (
            <Button className="px-2.5 py-1 text-xs" onClick={cancel}>
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            className="px-2.5 py-1 text-xs"
            title="Posts on the Git host under your name"
            disabled={props.pending || body.trim() === ''}
            onClick={submit}
          >
            {props.pending && <Spinner />}
            {props.submitLabel}
          </Button>
        </span>
      </div>
    </div>
  );
}

/** What a thread's own Check reply and Address comment buttons do; the pull request page provides it. */
export type ThreadActions = {
  /** The PR Session's turn is running: the buttons wait. */
  busy: boolean;
  /** The action whose start request is in flight. */
  starting: PrAction | null;
  start: (action: PrAction.CheckReplies | PrAction.AddressComments, commentId: string) => void;
};

export const ThreadActionsContext = createContext<ThreadActions | null>(null);

export const SESSION_BUSY = 'The Session is working on this pull request';

/** ⋯ on a thread: Delete for each comment the operator or the agent wrote, then a second click to confirm, since the host keeps no copy. */
function ThreadMenu({
  mine,
  onDelete,
  pendingId,
}: {
  mine: PrComment[];
  onDelete: (comment: PrComment) => void;
  pendingId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<PrComment | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node)) {
        setOpen(false);
        setConfirming(null);
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
        aria-label="More for this thread"
        title="Delete one of your comments on the Git host"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setConfirming(null);
        }}
        className={`flex size-6.5 cursor-pointer items-center justify-center rounded-md border text-sm leading-none ${open ? 'border-accent-400 bg-accent-100 text-text' : 'border-divider bg-card text-neutral-700 hover:text-text'}`}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 bottom-full z-20 mb-1 w-60 overflow-hidden rounded-lg border border-divider bg-card py-1 font-body shadow-lg"
        >
          {confirming ? (
            <div className="flex flex-col gap-2 px-3 py-2">
              <span className="text-xs text-neutral-700">
                Delete this comment from the pull request? It cannot be undone.
              </span>
              <span className="flex gap-1.5">
                <Button
                  variant="primary"
                  className="px-2.5 py-1 text-xs"
                  disabled={pendingId !== null}
                  onClick={() => onDelete(confirming)}
                >
                  {pendingId === confirming.id && <Spinner />}
                  Delete
                </Button>
                <Button
                  className="px-2.5 py-1 text-xs"
                  disabled={pendingId !== null}
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </Button>
              </span>
            </div>
          ) : mine.length === 0 ? (
            <div className="px-3 py-2 text-xs text-neutral-700">You wrote no comment in this thread.</div>
          ) : (
            mine.map((comment) => (
              <button
                key={comment.id}
                type="button"
                role="menuitem"
                onClick={() => setConfirming(comment)}
                className="block w-full cursor-pointer border-0 bg-transparent px-3 py-1.5 text-left font-body text-[13px] text-accent-700 hover:bg-neutral-200"
              >
                Delete your comment from {ago(comment.created_at)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const CHIP = 'flex-none rounded-full px-2 py-px font-body text-xs font-semibold';

/** The code the comment is on: the diff hunk's last lines, the commented one marked. */
function ThreadCode({ hunk }: { hunk: string }) {
  return (
    <div
      role="img"
      aria-label="The code this comment is on"
      className="overflow-x-auto border-b border-line font-mono text-xs leading-5"
    >
      {hunkRows(hunk).map((row, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: hunk lines have no id
          key={index}
          className={`flex w-max min-w-full whitespace-pre pr-3 ${
            row.header
              ? 'bg-diff-hunk text-diff-hunk-text'
              : row.sign === '+'
                ? 'bg-diff-add'
                : row.sign === '-'
                  ? 'bg-diff-del'
                  : ''
          } ${row.marked ? 'shadow-[inset_3px_0_0_var(--color-accent)]' : ''}`}
        >
          <span className="w-11 flex-none select-none pr-2.5 text-right text-neutral-600">{row.number ?? ''}</span>
          <span>{row.header ? row.text : `${row.sign === ' ' ? ' ' : row.sign} ${row.text}`}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * One comment thread as a card: its state and place, the code it is on, its comments, and Resolve, Reply, the agent's
 * Check reply and Address comment, and ⋯ to delete your own. The header folds it; a resolved thread starts folded.
 */
export function Thread({
  pr,
  root,
  showCode = true,
}: {
  pr: PullRequestDetail;
  root: PrComment;
  /** Show the code the comment is on; off when the thread already sits under its line in the diff. */
  showCode?: boolean;
}) {
  const { repo_id: repoId, number } = pr;
  const post = usePostComment(repoId, number);
  const resolve = useResolveComment(repoId, number);
  const remove = useDeleteComment(repoId, number);
  const actions = useContext(ThreadActionsContext);
  const [replying, setReplying] = useStored(`workspace.replying.${repoId}#${number}.${root.id}`, z.boolean(), false);
  const [open, setOpen] = useStored(
    `workspace.thread-open.${repoId}#${number}.${root.id}`,
    z.boolean(),
    !root.resolved,
  );
  const replies = pr.comments
    .filter((comment) => comment.parent_id === root.id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const comments = [root, ...replies];
  const inline = root.file_path !== null;
  const outdated = isOutdated(pr.files, root);
  const error = resolve.error ?? remove.error;
  const place =
    root.file_path === null ? 'General comment' : `${root.file_path}${root.line ? ` · line ${root.line}` : ''}`;
  const check = canCheck({ root, replies });
  const waiting = actions?.busy ?? false;
  return (
    <div
      data-thread={root.id}
      className={`overflow-hidden rounded-lg border border-divider bg-card font-body shadow-sm ${root.resolved ? 'opacity-80' : ''}`}
    >
      <button
        type="button"
        aria-expanded={open}
        title={open ? 'Fold this thread' : 'Open this thread'}
        onClick={() => setOpen(!open)}
        className={`flex w-full cursor-pointer items-center gap-2 border-0 bg-surface px-3 py-1.5 text-left text-xs text-text ${open ? 'border-b border-line' : ''}`}
      >
        <span aria-hidden className={`text-xs text-neutral-600 transition-transform ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
        <span className={`${CHIP} ${root.resolved ? 'bg-ok/15 text-ok' : 'bg-accent-100 text-accent-700'}`}>
          {root.resolved ? 'resolved' : 'open'}
        </span>
        <span className="min-w-0 truncate font-mono">{place}</span>
        {outdated && (
          <span title="A later commit moved or removed this line" className={`${CHIP} bg-warn/15 text-warn`}>
            Outdated
          </span>
        )}
        {!open && (
          <span className="ml-auto flex-none text-neutral-600">
            {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
          </span>
        )}
      </button>
      {open && (
        <>
          {showCode && root.hunk !== null && <ThreadCode hunk={root.hunk} />}
          {comments.map((comment) => (
            <div key={comment.id} className="flex gap-2.5 border-b border-line px-3 py-2.5 text-[13px]">
              <Avatar name={comment.author} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs">
                  <strong>{comment.author}</strong>
                  {comment.by_agent && (
                    <span
                      title="The agent wrote this comment on your behalf"
                      className={`${CHIP} bg-accent-100 text-accent-700`}
                    >
                      agent
                    </span>
                  )}
                  <span title={new Date(comment.created_at).toLocaleString()} className="text-neutral-600">
                    {ago(comment.created_at)}
                  </span>
                </div>
                <Markdown source={comment.body} className="mt-1" />
              </div>
            </div>
          ))}
          {replying && (
            <div className="border-b border-line bg-surface px-3 py-2">
              <CommentComposer
                label={`Reply to ${root.author}`}
                draft={`${repoId}#${number}.reply.${root.id}`}
                placeholder="Reply in this thread"
                submitLabel="Reply"
                pending={post.isPending}
                error={post.error}
                autoFocus
                onCancel={() => setReplying(false)}
                onSubmit={(body, done) =>
                  post.mutate(
                    { body, parent_id: root.id },
                    {
                      onSuccess: () => {
                        done();
                        setReplying(false);
                      },
                    },
                  )
                }
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
            {inline && (
              <Button
                className="px-2.5 py-1 text-xs"
                disabled={resolve.isPending}
                title={
                  root.resolved
                    ? 'Open this thread again on the Git host'
                    : 'Mark this thread resolved on the Git host. Address comments skips resolved threads.'
                }
                onClick={() => resolve.mutate({ comment_id: root.id, resolved: !root.resolved })}
              >
                {root.resolved ? 'Unresolve' : 'Resolve'}
              </Button>
            )}
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={replying}
              title="Reply in this thread on the Git host"
              onClick={() => setReplying(true)}
            >
              Reply
            </Button>
            {actions && !root.resolved && (
              <>
                <span aria-hidden className="mx-1 h-4.5 w-px bg-divider" />
                {check && (
                  <Button
                    className="border-accent-200 bg-accent-100 px-2.5 py-1 text-xs text-accent-900"
                    disabled={waiting || actions.starting !== null}
                    title={
                      waiting
                        ? SESSION_BUSY
                        : 'The agent reads the replies in this thread against the code and says whether each is fixed. The console posts its answer here and resolves the thread when it is fixed.'
                    }
                    onClick={() => actions.start(PrAction.CheckReplies, root.id)}
                  >
                    {actions.starting === PrAction.CheckReplies && <Spinner />}✓ Check reply
                  </Button>
                )}
                <Button
                  className="border-accent-200 bg-accent-100 px-2.5 py-1 text-xs text-accent-900"
                  disabled={waiting || actions.starting !== null}
                  title={
                    waiting
                      ? SESSION_BUSY
                      : 'The agent changes the code for this thread. The console pushes one commit to the branch, replies here and resolves the thread.'
                  }
                  onClick={() => actions.start(PrAction.AddressComments, root.id)}
                >
                  {actions.starting === PrAction.AddressComments && <Spinner />}✎ Address comment
                </Button>
              </>
            )}
            <span className="ml-auto">
              <ThreadMenu
                mine={comments.filter((comment) => comment.is_mine)}
                pendingId={remove.isPending ? (remove.variables ?? null) : null}
                onDelete={(comment) => remove.mutate(comment.id)}
              />
            </span>
          </div>
          {error && (
            <div role="alert" className="px-3 pb-2 text-xs text-accent-700">
              {error.message}
            </div>
          )}
        </>
      )}
    </div>
  );
}
