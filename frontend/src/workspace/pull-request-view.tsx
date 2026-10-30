import { type PrComment, PrReviewEvent, PrReviewState, PrState } from '@ops-console/shared';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import {
  useMergePullRequest,
  usePostComment,
  usePullRequest,
  useResolveComment,
  useReviewPullRequest,
  useStartAgentReview,
} from '../lib/queries';
import { AgentReviewCard } from './agent-review-card';

function Thread({
  repoId,
  number,
  root,
  replies,
}: {
  repoId: string;
  number: number;
  root: PrComment;
  replies: PrComment[];
}) {
  const post = usePostComment(repoId, number);
  const resolve = useResolveComment(repoId, number);
  const [reply, setReply] = useState('');
  const inline = root.file_path !== null;
  const submit = () => {
    if (reply.trim() === '') return;
    post.mutate({ body: reply, parent_id: root.id }, { onSuccess: () => setReply('') });
  };
  return (
    <li className={`border border-divider ${root.resolved ? 'opacity-60' : ''}`}>
      {[root, ...replies].map((comment) => (
        <div key={comment.id} className="border-b border-divider px-3 py-2 text-[13px] last:border-b-0">
          <div className="flex items-center gap-2 text-xs">
            <strong>{comment.author}</strong>
            {comment.by_agent && <span className="border border-text px-1.5 py-px text-[10px]">agent</span>}
            {comment.id === root.id && inline && (
              <span className="font-mono text-neutral-700">
                {root.file_path}
                {root.line ? `:${root.line}` : ''}
              </span>
            )}
            {comment.id === root.id && inline && (
              <Button
                className="ml-auto px-2 py-0.5 text-[11px]"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ comment_id: root.id, resolved: !root.resolved })}
              >
                {root.resolved ? 'Unresolve' : 'Resolve'}
              </Button>
            )}
          </div>
          <p className="m-0 mt-1 whitespace-pre-wrap">{comment.body}</p>
        </div>
      ))}
      <div className="flex gap-1.5 px-3 py-2">
        <input
          aria-label={`Reply to ${root.author}`}
          value={reply}
          placeholder="Reply in this thread"
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
          className="min-w-0 flex-1 border-[1.5px] border-text bg-bg px-2 py-1 text-xs text-text"
        />
        <Button className="px-2.5 py-1 text-xs" disabled={post.isPending || reply.trim() === ''} onClick={submit}>
          Reply
        </Button>
      </div>
      {(post.isError || resolve.isError) && (
        <div role="alert" className="px-3 pb-2 text-xs text-accent-700">
          {(post.error ?? resolve.error)?.message}
        </div>
      )}
    </li>
  );
}

export function PullRequestView({ repoId, number }: { repoId: string; number: number }) {
  const pull = usePullRequest(repoId, number);
  const review = useReviewPullRequest(repoId, number);
  const merge = useMergePullRequest(repoId, number);
  const agent = useStartAgentReview(repoId, number);
  const [changes, setChanges] = useState<string | null>(null);
  const [confirmMerge, setConfirmMerge] = useState(false);

  if (pull.isPending) return <Empty>Reading the pull request…</Empty>;
  if (pull.isError) return <Empty>Could not read the pull request: {pull.error.message}</Empty>;
  const pr = pull.data;
  const roots = pr.comments.filter((comment) => comment.parent_id === null);
  const open = pr.state === PrState.Open;
  const error = review.error ?? merge.error ?? agent.error;

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <header className="flex flex-col gap-2">
        <h2 className="m-0 text-[17px] font-extrabold">
          #{pr.number} {pr.title}
        </h2>
        <div className="flex flex-wrap gap-x-3 font-mono text-xs text-neutral-700">
          <a href={pr.url} target="_blank" rel="noreferrer" className="text-text underline">
            Open on the host
          </a>
          <span>
            {pr.branch} → {pr.base_branch}
          </span>
          <span>{pr.author}</span>
          <span>{pr.state}</span>
          <span>
            +{pr.additions} −{pr.deletions}
          </span>
          <span>checks {pr.checks}</span>
          <span>review {pr.review_state.replace('_', ' ')}</span>
          <span>
            {pr.comment_count} comments · {pr.resolved_count} resolved
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {open && !pr.is_mine && (
            <>
              <Button
                disabled={review.isPending}
                onClick={() => review.mutate({ event: PrReviewEvent.Approve })}
                className="px-3 py-1 text-xs"
              >
                Approve
              </Button>
              <Button className="px-3 py-1 text-xs" onClick={() => setChanges(changes === null ? '' : null)}>
                Request changes
              </Button>
            </>
          )}
          <Button
            variant="primary"
            className="px-3 py-1 text-xs"
            disabled={agent.isPending}
            onClick={() => agent.mutate()}
          >
            Agent Review
          </Button>
          {open && !confirmMerge && (
            <Button
              className="ml-auto px-3 py-1 text-xs"
              disabled={pr.review_state !== PrReviewState.Approved}
              title={pr.review_state === PrReviewState.Approved ? 'Merge' : 'Merge needs an approved review'}
              onClick={() => setConfirmMerge(true)}
            >
              Merge
            </Button>
          )}
          {confirmMerge && (
            <span className="ml-auto flex items-center gap-1.5 text-xs">
              Merge #{pr.number} on the host?
              <Button
                variant="primary"
                className="px-2.5 py-1 text-xs"
                disabled={merge.isPending}
                onClick={() => merge.mutate(undefined, { onSettled: () => setConfirmMerge(false) })}
              >
                Merge
              </Button>
              <Button className="px-2.5 py-1 text-xs" onClick={() => setConfirmMerge(false)}>
                Keep open
              </Button>
            </span>
          )}
        </div>
        {changes !== null && (
          <div className="flex gap-1.5">
            <input
              aria-label="What needs to change"
              value={changes}
              onChange={(event) => setChanges(event.target.value)}
              placeholder="What needs to change"
              className="min-w-0 flex-1 border-[1.5px] border-text bg-bg px-2 py-1 text-xs text-text"
            />
            <Button
              className="px-2.5 py-1 text-xs"
              disabled={changes.trim() === '' || review.isPending}
              onClick={() =>
                review.mutate(
                  { event: PrReviewEvent.RequestChanges, body: changes },
                  { onSuccess: () => setChanges(null) },
                )
              }
            >
              Send
            </Button>
          </div>
        )}
        {error && (
          <div role="alert" className="text-xs text-accent-700">
            {error.message}
          </div>
        )}
      </header>

      {pr.latest_agent_review && <AgentReviewCard review={pr.latest_agent_review} />}

      {pr.body && <p className="m-0 whitespace-pre-wrap text-[13px]">{pr.body}</p>}

      <section aria-label="Files" className="flex flex-col gap-2">
        <div className="text-[11px] tracking-[0.08em] text-neutral-700 uppercase">Files · {pr.files.length}</div>
        {pr.files.map((file) => (
          <details key={file.name} className="border border-divider">
            <summary className="cursor-pointer bg-surface px-3 py-1.5 font-mono text-xs">
              {file.name}{' '}
              <span className="text-neutral-700">
                +{file.additions} −{file.deletions}
              </span>
            </summary>
            <div className="overflow-x-auto font-mono text-xs">
              {file.lines.map((line, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: patch lines have no id
                  key={index}
                  className={`whitespace-pre px-3 ${line.sign === '+' ? 'bg-neutral-200' : line.sign === '-' ? 'bg-accent-100 text-accent-700' : ''}`}
                >
                  {line.sign} {line.text}
                </div>
              ))}
            </div>
          </details>
        ))}
      </section>

      <section aria-label="Comments" className="flex flex-col gap-2">
        <div className="text-[11px] tracking-[0.08em] text-neutral-700 uppercase">Comments · {pr.comments.length}</div>
        {roots.length === 0 ? (
          <div className="text-[13px] text-neutral-700">No comments yet.</div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {roots.map((root) => (
              <Thread
                key={root.id}
                repoId={repoId}
                number={number}
                root={root}
                replies={pr.comments.filter((comment) => comment.parent_id === root.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
