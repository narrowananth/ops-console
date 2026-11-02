import { type PrComment, PrState, type PullRequestDetail } from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button, Spinner } from '../components/ui/button';
import { Markdown } from '../components/ui/markdown';
import { useDeleteComment, usePostComment, useResolveComment, useStartReplyCheck } from '../lib/queries';
import { useStored } from '../lib/remember';
import { agentBusy, BUSY_TITLE, CHECK_REPLY_TIP, lastOf } from './pr-jobs';
import { ReplyCheckStrip } from './reply-check-strip';

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
        className="min-h-16 w-full resize-y rounded-md border border-divider bg-bg px-2.5 py-2 font-body text-[13px] text-text outline-none focus:border-accent-400 focus:shadow-[0_0_0_3px_var(--color-accent-100)]"
      />
      <div className="flex items-center gap-2">
        <span title="Write in Markdown. ⌘Enter or Ctrl+Enter sends." className="text-[11px] text-neutral-600">
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

/** ⋯ on a comment the operator or the agent wrote: Delete, then a second click to confirm, since the host keeps no copy. */
function CommentMenu({ comment, onDelete, pending }: { comment: PrComment; onDelete: () => void; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node)) {
        setOpen(false);
        setConfirming(false);
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
        aria-label={`More for the comment by ${comment.author}`}
        title="Delete this comment on the Git host"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setConfirming(false);
        }}
        className={`flex size-6 cursor-pointer items-center justify-center rounded-md border text-sm leading-none ${open ? 'border-accent-400 bg-accent-100 text-text' : 'border-transparent bg-transparent text-neutral-700 hover:border-divider hover:bg-card hover:text-text'}`}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-20 mt-1 w-56 overflow-hidden rounded-lg border border-divider bg-card py-1 font-body shadow-lg"
        >
          {confirming ? (
            <div className="flex flex-col gap-2 px-3 py-2">
              <span className="text-xs text-neutral-700">
                Delete this comment from the pull request? It cannot be undone.
              </span>
              <span className="flex gap-1.5">
                <Button variant="primary" className="px-2.5 py-1 text-xs" disabled={pending} onClick={onDelete}>
                  {pending && <Spinner />}
                  Delete
                </Button>
                <Button className="px-2.5 py-1 text-xs" disabled={pending} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </span>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => setConfirming(true)}
              className="block w-full cursor-pointer border-0 bg-transparent px-3 py-1.5 text-left font-body text-[13px] text-accent-700 hover:bg-neutral-200"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One comment thread: its comments, Resolve and Check reply for a thread on a line, ⋯ to delete your own, the
 * thread's running or failed Reply check, and a reply box.
 */
export function Thread({
  pr,
  root,
  showPlace = true,
}: {
  pr: PullRequestDetail;
  root: PrComment;
  /** Name the file and line; off when the thread already sits under its line. */
  showPlace?: boolean;
}) {
  const { repo_id: repoId, number } = pr;
  const post = usePostComment(repoId, number);
  const resolve = useResolveComment(repoId, number);
  const remove = useDeleteComment(repoId, number);
  const startCheck = useStartReplyCheck(repoId, number);
  const [replying, setReplying] = useStored(`workspace.replying.${repoId}#${number}.${root.id}`, z.boolean(), false);
  const replies = pr.comments.filter((comment) => comment.parent_id === root.id);
  const inline = root.file_path !== null;
  const check = pr.reply_checks.find((item) => item.comment_id === root.id);
  const canCheck =
    pr.state === PrState.Open && inline && root.line !== null && !root.resolved && !lastOf(root, replies).by_agent;
  const busy = agentBusy(pr);
  const error = startCheck.error ?? resolve.error ?? remove.error;
  return (
    <div
      className={`overflow-hidden rounded-lg border border-divider bg-card font-body shadow-sm ${root.resolved ? 'opacity-70' : ''}`}
    >
      {[root, ...replies].map((comment) => (
        <div key={comment.id} className="border-b border-line px-3 py-2.5 text-[13px] last:border-b-0">
          <div className="flex items-center gap-2 text-xs">
            <span
              aria-hidden
              className="flex size-5 flex-none items-center justify-center rounded-full bg-neutral-300 text-[10px] font-bold uppercase"
            >
              {comment.author.slice(0, 1)}
            </span>
            <strong>{comment.author}</strong>
            {comment.by_agent && (
              <span
                title="The agent wrote this comment on your behalf"
                className="rounded-full bg-accent-100 px-2 py-px text-[10px] font-semibold text-accent-700"
              >
                agent
              </span>
            )}
            <span className="text-neutral-600">{new Date(comment.created_at).toLocaleString()}</span>
            {comment.id === root.id && inline && showPlace && (
              <span className="min-w-0 truncate font-mono text-neutral-700">
                {root.file_path}
                {root.line ? `:${root.line}` : ''}
              </span>
            )}
            <span className="ml-auto flex flex-none items-center gap-1.5">
              {comment.id === root.id && canCheck && (
                <Button
                  className="px-2 py-0.5 text-[11px]"
                  disabled={busy || startCheck.isPending}
                  title={busy ? BUSY_TITLE : CHECK_REPLY_TIP}
                  onClick={() => startCheck.mutate(root.id)}
                >
                  {startCheck.isPending && <Spinner />}
                  Check reply
                </Button>
              )}
              {comment.id === root.id && inline && (
                <Button
                  className="px-2 py-0.5 text-[11px]"
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
              {comment.is_mine && (
                <CommentMenu
                  comment={comment}
                  pending={remove.isPending && remove.variables === comment.id}
                  onDelete={() => remove.mutate(comment.id)}
                />
              )}
            </span>
          </div>
          <Markdown source={comment.body} className="mt-1.5" />
        </div>
      ))}
      {check && <ReplyCheckStrip check={check} sessionId={pr.agent_session_id} />}
      <div className="border-t border-line bg-surface px-3 py-2">
        {replying ? (
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
        ) : (
          <button
            type="button"
            onClick={() => setReplying(true)}
            title="Reply in this thread on the Git host"
            className="w-full cursor-pointer rounded-md border border-divider bg-card px-2.5 py-1.5 text-left text-xs text-neutral-600 hover:border-neutral-400 hover:text-text"
          >
            Reply…
          </button>
        )}
      </div>
      {error && (
        <div role="alert" className="px-3 pb-2 text-xs text-accent-700">
          {error.message}
        </div>
      )}
    </div>
  );
}
