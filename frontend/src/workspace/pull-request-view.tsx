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
import { Empty } from '../components/ui/empty';
import { FoldTitle, useFold } from '../components/ui/fold';
import { item, menu } from '../components/ui/item';
import { Markdown } from '../components/ui/markdown';
import { useMergePullRequest, usePullRequest, useReviewPullRequest, useStartPrAction } from '../lib/queries';
import { useStored } from '../lib/remember';
import { useTriggerPlaybook } from '../playbooks/job-steps';
import { withPlaybook } from '../playbooks/labels';
import { AddressCommentsDialog } from './address-comments';
import { AgentReviewDialog } from './agent-review-dialog';
import { sessionPath } from './links';
import { PrActivity } from './pr-activity';
import { useViewed } from './pr-file';
import { PrFiles } from './pr-files';
import { ConflictBanner, PrCommits } from './pr-history';
import {
  ADDRESS_TIP,
  AGENT_REVIEW_TIP,
  BUSY_TITLE,
  CHECK_REPLIES_TIP,
  openThreads,
  repliedThreads,
  roundWorking,
  sessionWorking,
} from './pr-jobs';
import { PrMeta, ToneMark } from './pr-meta';
import { PrSessions } from './pr-sessions';
import { ChecksSection, MergeChecksSection, PeopleSection, RailSection } from './pr-sidebar';
import { CommitsIcon, FilesIcon, OverviewIcon, PrTabs } from './pr-tabs';
import { type ThreadActions, ThreadActionsContext } from './pr-thread';

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
  const reviewPlaybook = useTriggerPlaybook(PlaybookTrigger.ReviewPr);
  const addressPlaybook = useTriggerPlaybook(PlaybookTrigger.AddressComments);
  const checkPlaybook = useTriggerPlaybook(PlaybookTrigger.CheckReply);
  // One Session serves the three buttons: while its turn runs, all of them wait.
  const working = sessionWorking(pr);
  const reviewing = roundWorking(pr, PrAction.Review);
  const checking = roundWorking(pr, PrAction.CheckReplies);
  // Its findings are already on the host; the next review waits for a new commit.
  const reviewed = pr.latest_agent_review !== null && !pr.latest_agent_review.stale;
  const open = pr.state === PrState.Open;
  const canAddress = open && openThreads(pr).length > 0;
  const replied = open ? repliedThreads(pr).length : 0;
  const error = review.error ?? merge.error ?? start.error;

  // A thread's own buttons start a Round for that thread; they wait while the PR Session's turn runs.
  const threadActions: ThreadActions = {
    busy: working,
    starting: start.isPending ? (start.variables?.action ?? null) : null,
    start: (action, commentId) => startAction({ action, comment_ids: [commentId] }),
  };

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
        disabled={start.isPending || working || reviewed}
        title={
          working
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

      <PrActivity pr={pr} />
    </>
  );

  const openCount = openThreads(pr).length;
  const sidebar = (
    <aside aria-label="Decision" className="flex min-h-0 w-76 flex-none flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2 pr-5 pl-1">
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
                disabled={start.isPending || working}
                title={working ? BUSY_TITLE : ADDRESS_TIP}
                onClick={() => setPicking(true)}
              >
                {start.isPending && start.variables?.action === PrAction.AddressComments && <Spinner />}
                {withPlaybook('Address comments', addressPlaybook)}
              </Button>
            )}
            {(replied > 0 || checking) && (
              <Button
                className="justify-center px-3 py-1.5 text-xs"
                disabled={start.isPending || working}
                title={working ? BUSY_TITLE : CHECK_REPLIES_TIP}
                onClick={() => startAction({ action: PrAction.CheckReplies })}
              >
                {start.isPending && start.variables?.action === PrAction.CheckReplies && <Spinner />}
                {withPlaybook('Check replies', checkPlaybook)}
                {replied > 0 && ` · ${replied}`}
              </Button>
            )}
          </div>
        </RailSection>
        <RailSection id="sessions" label="Sessions" summary="Sessions on this pull request">
          <PrSessions pr={pr} />
        </RailSection>
      </div>
    </aside>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex max-h-[60%] flex-none flex-col gap-3 overflow-y-auto border-b border-line px-6 pt-5">
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
      <ThreadActionsContext.Provider value={threadActions}>
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
        {tab === 'files' ? (
          // The rail is tied to the tab: the diff takes its width, and Overview and Commits bring it back.
          <PrFiles pr={pr} viewed={viewed} />
        ) : (
          <div className="flex min-h-0 flex-1 gap-6">
            <div
              role="tabpanel"
              className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-4 [scrollbar-gutter:stable] [&>*]:shrink-0"
            >
              {tab === 'overview' ? overview : <PrCommits pr={pr} />}
            </div>
            {sidebar}
          </div>
        )}
      </ThreadActionsContext.Provider>
    </div>
  );
}
