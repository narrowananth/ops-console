import {
  AgentReviewStatus,
  CommentPassKind,
  PlaybookTrigger,
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
import { PrMeta } from './pr-meta';
import { PrSessions } from './pr-sessions';
import { CommentComposer, Thread } from './pr-thread';

const FOLD_ALL =
  'cursor-pointer rounded border-0 bg-transparent px-1.5 py-0.5 text-xs text-neutral-700 hover:bg-neutral-200 hover:text-text';

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
  // Expand all or Collapse all, for this pull request only: another one opens with each file as it was left.
  const [fold, setFold] = useState<{ pr: string; open: boolean } | null>(null);
  const here = `${pr.repo_id}#${pr.number}`;
  const bulk = fold?.pr === here ? fold : null;
  const setBulk = ({ open }: { open: boolean }) => setFold({ pr: here, open });
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
        <h2 className="m-0 text-[17px] font-semibold">
          #{pr.number} {pr.title}
        </h2>
        <PrMeta pr={pr} />
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
          {open && (
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
          )}
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
        <div className="flex items-center gap-3 text-xs tracking-[0.08em] text-neutral-700 uppercase">
          Files · {pr.files.length}
          <DiffStat
            additions={pr.files.reduce((sum, file) => sum + file.additions, 0)}
            deletions={pr.files.reduce((sum, file) => sum + file.deletions, 0)}
          />
          {pr.files.length > 1 && (
            <span className="flex items-center gap-1 tracking-normal normal-case">
              <button
                type="button"
                title="Open every file on its lines"
                onClick={() => setBulk({ open: true })}
                className={FOLD_ALL}
              >
                Expand all
              </button>
              <button
                type="button"
                title="Fold every file to its name, to get to the comments and the end of the page"
                onClick={() => setBulk({ open: false })}
                className={FOLD_ALL}
              >
                Collapse all
              </button>
            </span>
          )}
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
            bulk={bulk}
          />
        ))}
      </section>

      <section aria-label="Comments" className="flex flex-col gap-2">
        <div className="text-xs tracking-[0.08em] text-neutral-700 uppercase">Comments · {pr.comments.length}</div>
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
