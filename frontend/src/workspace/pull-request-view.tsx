import {
  PlaybookTrigger,
  PrAction,
  PrMergeState,
  PrReviewEvent,
  PrReviewState,
  PrState,
  type PullRequestDetail,
} from '@ops-console/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button, Spinner } from '../components/ui/button';
import { DiffStat } from '../components/ui/diff';
import { Empty } from '../components/ui/empty';
import { FoldTitle, useFold } from '../components/ui/fold';
import { item, menu } from '../components/ui/item';
import { Markdown } from '../components/ui/markdown';
import {
  useMergePullRequest,
  usePostComment,
  usePullRequest,
  useReviewPullRequest,
  useStartPrAction,
} from '../lib/queries';
import { useStored } from '../lib/remember';
import { useTriggerPlaybook } from '../playbooks/job-steps';
import { withPlaybook } from '../playbooks/labels';
import { AddressCommentsDialog } from './address-comments';
import { AgentReviewDialog } from './agent-review-dialog';
import { sessionPath } from './links';
import { PrFileView, useViewed } from './pr-file';
import { ConflictBanner, PrCommits } from './pr-history';
import {
  ADDRESS_TIP,
  AGENT_REVIEW_TIP,
  actionOpen,
  BUSY_TITLE,
  CHECK_REPLIES_TIP,
  openThreads,
  repliedThreads,
} from './pr-jobs';
import { PrMeta, ToneMark } from './pr-meta';
import { PrSessions } from './pr-sessions';
import { ChecksSection, MergeChecksSection, PeopleSection, RailSection } from './pr-sidebar';
import { CommitsIcon, FilesIcon, OverviewIcon, PrTabs } from './pr-tabs';
import { CommentComposer, Thread } from './pr-thread';

const FOLD_ALL =
  'cursor-pointer rounded border-0 bg-transparent px-1.5 py-0.5 text-xs text-neutral-700 hover:bg-neutral-200 hover:text-text';

export function PullRequestView({ repoId, number }: { repoId: string; number: number }) {
  const pull = usePullRequest(repoId, number);
  const review = useReviewPullRequest(repoId, number);
  const merge = useMergePullRequest(repoId, number);
  const start = useStartPrAction(repoId, number);

  if (pull.isPending) return <Empty>Reading the pull request…</Empty>;
  if (pull.isError) return <Empty>Could not read the pull request: {pull.error.message}</Empty>;
  return <Loaded pr={pull.data} review={review} merge={merge} start={start} />;
}

function Loaded(props: {
  pr: PullRequestDetail;
  review: ReturnType<typeof useReviewPullRequest>;
  merge: ReturnType<typeof useMergePullRequest>;
  start: ReturnType<typeof useStartPrAction>;
}) {
  const { pr, review, merge, start } = props;
  const navigate = useNavigate();
  // Starting opens the new Session, as New Session does.
  const startAction = (input: Parameters<typeof start.mutate>[0]) =>
    start.mutate(input, { onSuccess: (session) => navigate(sessionPath(session.id)) });
  const [changes, setChanges] = useStored(
    `workspace.draft.${pr.repo_id}#${pr.number}.changes`,
    z.string().nullable(),
    null,
  );
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [picking, setPicking] = useState(false);
  const [noting, setNoting] = useState(false);
  const [more, setMore] = useState(false);
  const [tab, setTab] = useStored('workspace.pr-tab', z.enum(['overview', 'files', 'commits']), 'overview');
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
  const comment = usePostComment(pr.repo_id, pr.number);
  const reviewing = actionOpen(pr, PrAction.Review);
  const addressing = actionOpen(pr, PrAction.AddressComments);
  const checking = actionOpen(pr, PrAction.CheckReplies);
  // Its findings are already on the host; the next review waits for a new commit.
  const reviewed = pr.latest_agent_review !== null && !pr.latest_agent_review.stale;
  const roots = pr.comments.filter((comment) => comment.parent_id === null);
  const open = pr.state === PrState.Open;
  const canAddress = open && openThreads(pr).length > 0;
  const replied = open ? repliedThreads(pr).length : 0;
  const error = review.error ?? merge.error ?? start.error;

  const BTN = 'px-3 py-1.5 text-xs';
  const approved = pr.review_state === PrReviewState.Approved;
  const conflicted = pr.conflicts?.state === PrMergeState.Conflict;
  // Files changed renders on the next paint; then the file scrolls into view.
  const openFile = (name: string) => {
    setTab('files');
    requestAnimationFrame(() =>
      document.querySelector(`section[aria-label="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'start' }),
    );
  };
  const actions = open && (
    <div className="flex flex-none flex-wrap items-center justify-end gap-1.5">
      <Button
        className={BTN}
        disabled={start.isPending || reviewing || reviewed}
        title={
          reviewing
            ? BUSY_TITLE
            : reviewed
              ? 'The agent already reviewed this commit. Push a change to review again.'
              : AGENT_REVIEW_TIP
        }
        onClick={() => setNoting(true)}
      >
        {reviewing && <Spinner />}
        {reviewing
          ? 'Agent reviewing…'
          : start.isPending && start.variables?.action === PrAction.Review
            ? 'Starting…'
            : reviewed
              ? 'Reviewed at this commit'
              : withPlaybook('Agent Review', reviewPlaybook)}
      </Button>
      {!pr.is_mine && (
        <Button
          className={BTN}
          disabled={review.isPending}
          title={`Approve this pull request on the Git host as you. ${viewed.count} of ${pr.files.length} files viewed.`}
          onClick={() => review.mutate({ event: PrReviewEvent.Approve })}
        >
          <span aria-hidden className="text-ok">
            ✓
          </span>
          Approve
        </Button>
      )}
      <Button
        variant="primary"
        className={BTN}
        disabled={!approved || conflicted || confirmMerge}
        title={
          conflicted
            ? `Merge waits until the conflicts with ${pr.base_branch} are resolved on ${pr.branch}`
            : approved
              ? 'Merge this pull request on the Git host. You confirm first.'
              : 'Merge needs an approved review. Approve it here or on the Git host first.'
        }
        onClick={() => setConfirmMerge(true)}
      >
        Merge
      </Button>
      {!pr.is_mine && (
        <div className="relative">
          <Button
            icon
            className="size-7.5"
            aria-label="More actions"
            aria-expanded={more}
            title="More actions"
            onClick={() => setMore(!more)}
          >
            <span aria-hidden className="text-base leading-none">
              ⋯
            </span>
          </Button>
          {more && (
            <>
              <button
                type="button"
                aria-label="Close the menu"
                tabIndex={-1}
                className="fixed inset-0 z-40 cursor-default border-0 bg-transparent"
                onClick={() => setMore(false)}
              />
              <div className={`absolute top-full right-0 z-41 mt-1 flex w-52 flex-col ${menu}`}>
                <button
                  type="button"
                  title="Say what needs to change. It posts a review on the Git host that asks the author for changes."
                  className={`px-2.5 py-1.5 text-[13px] ${item(false)}`}
                  onClick={() => {
                    setMore(false);
                    setChanges(changes === null ? '' : null);
                  }}
                >
                  Request changes
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );

  const files = (
    <section aria-label="Files" className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-xs text-neutral-700">
        <DiffStat
          additions={pr.files.reduce((sum, file) => sum + file.additions, 0)}
          deletions={pr.files.reduce((sum, file) => sum + file.deletions, 0)}
        />
        {pr.files.length > 1 && (
          <span className="flex items-center gap-1">
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
            className="ml-auto flex items-center gap-2"
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
  );

  const overview = (
    <>
      <ConflictBanner pr={pr} onOpenFile={openFile} />

      <section aria-label="Description" className="flex flex-col gap-1.5">
        <h3 className="m-0 text-sm">
          <FoldTitle label="Description" folded={descriptionFolded} onToggle={toggleDescription}>
            <strong>Description</strong>
          </FoldTitle>
        </h3>
        <div hidden={descriptionFolded} className="pl-5">
          {pr.body.trim() === '' ? (
            <p className="m-0 text-[13px] text-neutral-700">No description.</p>
          ) : (
            <Markdown source={pr.body} />
          )}
        </div>
      </section>

      <section aria-label="Comments" className="flex flex-col gap-3">
        <h3 className="m-0 flex items-center gap-2 text-sm font-semibold">
          Activity
          <span className="text-xs font-normal text-neutral-700">
            {pr.comments.length} {pr.comments.length === 1 ? 'comment' : 'comments'}
          </span>
        </h3>
        <CommentComposer
          label="Comment on the pull request"
          draft={`${pr.repo_id}#${pr.number}.comment`}
          placeholder="What do you want to say?"
          submitLabel="Comment"
          pending={comment.isPending}
          error={comment.error}
          onSubmit={(body, done) => comment.mutate({ body }, { onSuccess: done })}
        />
        {roots.length === 0 ? (
          <div className="text-[13px] text-neutral-700">
            No comments yet. Open Files changed, hover a line and press + to comment on it.
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
      </section>
    </>
  );

  const openCount = openThreads(pr).length;
  const sidebar = (
    <aside aria-label="Decision" className="w-76 flex-none">
      <div className="sticky top-0 flex max-h-[calc(100vh-4rem)] flex-col overflow-y-auto py-2 pr-5 pl-1">
        <ChecksSection pr={pr} />
        <MergeChecksSection pr={pr} />
        <PeopleSection pr={pr} />
        <RailSection
          id="threads"
          label="Threads"
          summary={`${openCount} ${openCount === 1 ? 'thread' : 'threads'} open · ${pr.resolved_count} resolved`}
          mark={<ToneMark tone={openCount > 0 ? 'bad' : 'ok'} />}
        >
          <div className="flex flex-col gap-1.5">
            {!canAddress && replied === 0 && !checking && (
              <span className="text-xs text-neutral-700">Nothing for the agent to address.</span>
            )}
            {canAddress && (
              <Button
                className="justify-center px-3 py-1.5 text-xs"
                disabled={start.isPending || addressing}
                title={addressing ? BUSY_TITLE : ADDRESS_TIP}
                onClick={() => setPicking(true)}
              >
                {start.isPending && start.variables?.action === PrAction.AddressComments && <Spinner />}
                {withPlaybook('Address comments', addressPlaybook)}
              </Button>
            )}
            {(replied > 0 || checking) && (
              <Button
                className="justify-center px-3 py-1.5 text-xs"
                disabled={start.isPending || checking}
                title={checking ? BUSY_TITLE : CHECK_REPLIES_TIP}
                onClick={() => startAction({ action: PrAction.CheckReplies })}
              >
                {start.isPending && start.variables?.action === PrAction.CheckReplies && <Spinner />}
                {withPlaybook('Check replies', checkPlaybook)}
                {replied > 0 && ` · ${replied}`}
              </Button>
            )}
          </div>
        </RailSection>
        <RailSection id="sessions" label="Sessions" summary="Sessions on this branch">
          <PrSessions pr={pr} />
        </RailSection>
      </div>
    </aside>
  );

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-line px-6 pt-5">
        <h2 className="m-0 text-xl leading-snug font-semibold">
          <span className="font-normal text-neutral-600">#{pr.number}</span> {pr.title}
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PrMeta pr={pr} />
          {actions}
        </div>
        {confirmMerge && (
          <div className="flex items-center gap-2 self-end rounded-md border border-line bg-card px-3 py-2 text-xs shadow-sm">
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
          </div>
        )}
        {changes !== null && (
          <div className="flex flex-col gap-1.5 self-end sm:w-96">
            <textarea
              aria-label="What needs to change"
              value={changes}
              rows={3}
              onChange={(event) => setChanges(event.target.value)}
              placeholder="What needs to change"
              className="min-w-0 resize-y rounded-md border border-divider bg-card px-2 py-1 text-xs text-text"
            />
            <div className="flex justify-end gap-1.5">
              <Button className="px-2.5 py-1 text-xs" onClick={() => setChanges(null)}>
                Cancel
              </Button>
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
          </div>
        )}
        {error && (
          <div role="alert" className="self-end text-xs text-accent-700">
            {error.message}
          </div>
        )}
        <div className="pb-3">
          <PrTabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'overview', label: 'Overview', icon: <OverviewIcon /> },
              { id: 'files', label: 'Files changed', icon: <FilesIcon />, count: pr.files.length },
              { id: 'commits', label: 'Commits', icon: <CommitsIcon />, count: pr.commits.length },
            ]}
          />
        </div>
      </header>
      <div className="flex flex-1 gap-6">
        <div role="tabpanel" className="flex min-w-0 flex-1 flex-col gap-5 py-4 pl-6">
          {noting && (
            <AgentReviewDialog
              onCancel={() => setNoting(false)}
              onStart={(note) => {
                setNoting(false);
                startAction({ action: PrAction.Review, ...(note ? { note } : {}) });
              }}
            />
          )}
          {picking && (
            <AddressCommentsDialog
              pr={pr}
              onCancel={() => setPicking(false)}
              onStart={(commentIds) => {
                setPicking(false);
                startAction({ action: PrAction.AddressComments, comment_ids: commentIds });
              }}
            />
          )}
          {tab === 'overview' ? overview : tab === 'files' ? files : <PrCommits pr={pr} />}
        </div>
        {sidebar}
      </div>
    </div>
  );
}
