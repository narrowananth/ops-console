import {
  AgentReviewStatus,
  CommentPassKind,
  PlaybookTrigger,
  PrChecks,
  PrReviewEvent,
  PrReviewState,
  PrState,
  type PullRequestDetail,
} from '@ops-console/shared';
import { useState } from 'react';
import { z } from 'zod';
import { Button, Spinner } from '../components/ui/button';
import { DiffStat } from '../components/ui/diff';
import { Empty } from '../components/ui/empty';
import { FoldTitle, useFold } from '../components/ui/fold';
import { Markdown } from '../components/ui/markdown';
import {
  useCheckReplies,
  useMergePullRequest,
  usePostComment,
  usePullRequest,
  useReviewPullRequest,
  useStartAgentReview,
  useStartCommentPass,
} from '../lib/queries';
import { useStored } from '../lib/remember';
import { useTriggerPlaybook } from '../playbooks/job-steps';
import { withPlaybook } from '../playbooks/labels';
import { AddressCommentsDialog } from './address-comments';
import { AgentReviewCard } from './agent-review-card';
import { CommentPassCard } from './comment-pass-card';
import { PrFileView, useViewed } from './pr-file';
import {
  ADDRESS_TIP,
  AGENT_REVIEW_TIP,
  agentBusy,
  BUSY_TITLE,
  CHECK_REPLIES_TIP,
  openThreads,
  repliedThreads,
} from './pr-jobs';
import { PrSessions } from './pr-sessions';
import { CommentComposer, Thread } from './pr-thread';

const STATE_TIP: Record<PrState, string> = {
  [PrState.Open]: 'Open: waiting for review and merge',
  [PrState.Merged]: 'Merged into the target branch',
  [PrState.Closed]: 'Closed without merging',
};

const CHECKS_TIP: Record<PrChecks, string> = {
  [PrChecks.None]: 'No CI checks reported on the newest commit',
  [PrChecks.Running]: 'CI checks are still running on the newest commit',
  [PrChecks.Passed]: 'Every CI check passed on the newest commit',
  [PrChecks.Failed]: 'At least one CI check failed on the newest commit. Open it on the host to see which.',
};

const REVIEW_TIP: Record<PrReviewState, string> = {
  [PrReviewState.None]: 'Nobody has approved or asked for changes yet',
  [PrReviewState.Approved]: 'A reviewer approved it',
  [PrReviewState.ChangesRequested]: 'A reviewer asked for changes',
};

export function PullRequestView({ repoId, number }: { repoId: string; number: number }) {
  const pull = usePullRequest(repoId, number);
  const review = useReviewPullRequest(repoId, number);
  const merge = useMergePullRequest(repoId, number);
  const agent = useStartAgentReview(repoId, number);
  const address = useStartCommentPass(repoId, number);

  if (pull.isPending) return <Empty>Reading the pull request…</Empty>;
  if (pull.isError) return <Empty>Could not read the pull request: {pull.error.message}</Empty>;
  return <Loaded pr={pull.data} review={review} merge={merge} agent={agent} address={address} />;
}

function Loaded(props: {
  pr: PullRequestDetail;
  review: ReturnType<typeof useReviewPullRequest>;
  merge: ReturnType<typeof useMergePullRequest>;
  agent: ReturnType<typeof useStartAgentReview>;
  address: ReturnType<typeof useStartCommentPass>;
}) {
  const { pr, review, merge, agent, address } = props;
  const [changes, setChanges] = useStored(
    `workspace.draft.${pr.repo_id}#${pr.number}.changes`,
    z.string().nullable(),
    null,
  );
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [picking, setPicking] = useState(false);
  const [descriptionFolded, toggleDescription] = useFold('description');
  const viewed = useViewed(pr);
  const reviewPlaybook = useTriggerPlaybook(PlaybookTrigger.ReviewPr);
  const addressPlaybook = useTriggerPlaybook(PlaybookTrigger.AddressComments);
  const checkPlaybook = useTriggerPlaybook(PlaybookTrigger.CheckReply);
  const checkReplies = useCheckReplies(pr.repo_id, pr.number);
  const comment = usePostComment(pr.repo_id, pr.number);
  const reviewing = pr.latest_agent_review?.status === AgentReviewStatus.Running;
  const busy = agentBusy(pr);
  // Its findings are already on the host; the next review waits for a new commit.
  const reviewed = pr.latest_agent_review?.status === AgentReviewStatus.Ready && !pr.latest_agent_review.stale;
  const roots = pr.comments.filter((comment) => comment.parent_id === null);
  const open = pr.state === PrState.Open;
  const canAddress = open && openThreads(pr).length > 0;
  const replied = open ? repliedThreads(pr).length : 0;
  const checking = pr.comment_passes.some(
    (pass) => pass.kind === CommentPassKind.Check && pass.status === AgentReviewStatus.Running,
  );
  const error = review.error ?? merge.error ?? agent.error ?? address.error ?? checkReplies.error;

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <header className="flex flex-col gap-2">
        <h2 className="m-0 text-[17px] font-extrabold">
          #{pr.number} {pr.title}
        </h2>
        <div className="flex flex-wrap gap-x-3 font-mono text-xs text-neutral-700">
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            title={`Open #${pr.number} on ${pr.host} in a new tab`}
            className="text-text underline"
          >
            Open on the host
          </a>
          <span title={`Merging brings ${pr.branch} into ${pr.base_branch}`}>
            {pr.branch} → {pr.base_branch}
          </span>
          <span title="Author">{pr.author}</span>
          <span title={STATE_TIP[pr.state]}>{pr.state}</span>
          <span title="Lines added and removed across every file">
            +{pr.additions} −{pr.deletions}
          </span>
          <span title={CHECKS_TIP[pr.checks]}>checks {pr.checks}</span>
          {pr.approved_by.length > 0 ? (
            <span className="font-semibold text-ok" title={`Approved by ${pr.approved_by.join(', ')}`}>
              ✓ approved by {pr.approved_by.join(', ')}
            </span>
          ) : (
            <span title={REVIEW_TIP[pr.review_state]}>review {pr.review_state.replace('_', ' ')}</span>
          )}
          <span title="Comments on the Git host, and how many of their threads are resolved">
            {pr.comment_count} comments · {pr.resolved_count} resolved
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {open && !pr.is_mine && (
            <>
              <Button
                disabled={review.isPending}
                title={`Approve this pull request on the Git host as you. ${viewed.count} of ${pr.files.length} files viewed.`}
                onClick={() => review.mutate({ event: PrReviewEvent.Approve })}
                className="px-3 py-1 text-xs"
              >
                Approve
              </Button>
              <Button
                className="px-3 py-1 text-xs"
                title="Say what needs to change. It posts a review on the Git host that asks the author for changes."
                onClick={() => setChanges(changes === null ? '' : null)}
              >
                Request changes
              </Button>
            </>
          )}
          <Button
            variant="primary"
            className="px-3 py-1 text-xs"
            disabled={agent.isPending || busy || reviewed}
            title={
              busy
                ? BUSY_TITLE
                : reviewed
                  ? 'The agent already reviewed this commit. Push a change to review again.'
                  : AGENT_REVIEW_TIP
            }
            onClick={() => agent.mutate()}
          >
            {reviewing && <Spinner />}
            {reviewing
              ? 'Agent reviewing…'
              : agent.isPending
                ? 'Starting…'
                : reviewed
                  ? 'Reviewed at this commit'
                  : withPlaybook('Agent Review', reviewPlaybook)}
          </Button>
          {(replied > 0 || checking) && (
            <Button
              className="px-3 py-1 text-xs"
              disabled={checkReplies.isPending || busy}
              title={busy ? BUSY_TITLE : CHECK_REPLIES_TIP}
              onClick={() => checkReplies.mutate()}
            >
              {(checkReplies.isPending || checking) && <Spinner />}
              {checking ? 'Checking replies…' : `${withPlaybook('Check replies', checkPlaybook)} · ${replied}`}
            </Button>
          )}
          {canAddress && (
            <Button
              className="px-3 py-1 text-xs"
              disabled={address.isPending || busy}
              title={busy ? BUSY_TITLE : ADDRESS_TIP}
              onClick={() => setPicking(true)}
            >
              {address.isPending && <Spinner />}
              {withPlaybook('Address comments', addressPlaybook)}
            </Button>
          )}
          {open && !confirmMerge && (
            <Button
              className="ml-auto px-3 py-1 text-xs"
              disabled={pr.review_state !== PrReviewState.Approved}
              title={
                pr.review_state === PrReviewState.Approved
                  ? 'Merge this pull request on the Git host. You confirm first.'
                  : 'Merge needs an approved review. Approve it here or on the Git host first.'
              }
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
                title={`Merge ${pr.branch} into ${pr.base_branch} on the Git host now`}
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
        <PrSessions pr={pr} />
        {changes !== null && (
          <div className="flex gap-1.5">
            <input
              aria-label="What needs to change"
              value={changes}
              onChange={(event) => setChanges(event.target.value)}
              placeholder="What needs to change"
              className="min-w-0 flex-1 border border-divider bg-card px-2 py-1 text-xs text-text"
            />
            <Button
              className="px-2.5 py-1 text-xs"
              title="Post this as a review that requests changes on the Git host"
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
        {picking && (
          <AddressCommentsDialog
            pr={pr}
            onCancel={() => setPicking(false)}
            onStart={(commentIds) => {
              setPicking(false);
              address.mutate(commentIds);
            }}
          />
        )}
      </header>

      {pr.latest_agent_review && <AgentReviewCard review={pr.latest_agent_review} sessionId={pr.agent_session_id} />}
      <CommentPassCard passes={pr.comment_passes} prUrl={pr.url} sessionId={pr.agent_session_id} />

      {pr.body.trim() !== '' && (
        <section aria-label="Description" className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
          <header
            className={`flex items-center gap-2 bg-surface px-4 py-2 text-xs ${descriptionFolded ? '' : 'border-b border-divider'}`}
          >
            <FoldTitle label="Description" folded={descriptionFolded} onToggle={toggleDescription}>
              <strong>Description</strong>
            </FoldTitle>
            <span className="text-neutral-700">by {pr.author}</span>
          </header>
          <div hidden={descriptionFolded}>
            <Markdown source={pr.body} className="px-4 py-3" />
          </div>
        </section>
      )}

      <section aria-label="Files" className="flex flex-col gap-2">
        <div className="flex items-center gap-3 text-[11px] tracking-[0.08em] text-neutral-700 uppercase">
          Files · {pr.files.length}
          <DiffStat
            additions={pr.files.reduce((sum, file) => sum + file.additions, 0)}
            deletions={pr.files.reduce((sum, file) => sum + file.deletions, 0)}
          />
          {pr.files.length > 0 && (
            <span
              title="Files you ticked Viewed, kept in this browser. A file whose change changes reads unviewed again."
              className="ml-auto flex items-center gap-2 tracking-normal normal-case"
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
        {pr.files.map((file) => (
          <PrFileView
            key={`${pr.head_sha}:${file.name}`}
            pr={pr}
            file={file}
            viewed={viewed.isViewed(file)}
            onViewed={(next) => viewed.set(file, next)}
          />
        ))}
      </section>

      <section aria-label="Comments" className="flex flex-col gap-2">
        <div className="text-[11px] tracking-[0.08em] text-neutral-700 uppercase">Comments · {pr.comments.length}</div>
        {roots.length === 0 ? (
          <div className="text-[13px] text-neutral-700">
            No comments yet. Hover a line in a file and press + to comment on it.
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {roots.map((root) => (
              <li key={root.id}>
                <Thread pr={pr} root={root} />
              </li>
            ))}
          </ul>
        )}
        <CommentComposer
          label="Comment on the pull request"
          draft={`${pr.repo_id}#${pr.number}.comment`}
          placeholder="Leave a comment on the pull request"
          submitLabel="Comment"
          pending={comment.isPending}
          error={comment.error}
          onSubmit={(body, done) => comment.mutate({ body }, { onSuccess: done })}
        />
      </section>
    </div>
  );
}
