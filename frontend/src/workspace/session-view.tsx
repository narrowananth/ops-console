import { type EditedMessage, FolderTarget, type OutputFile, SessionKind, SessionState } from '@ops-console/shared';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { MessageView, outputsByMessage } from '../agents/transcript';
import { BrowserLinksProvider } from '../browser/browser-links';
import { BROWSER_PANEL, BrowserPanel, type OpenRequest } from '../browser/browser-panel';
import { freshServers, serverAddress, sessionPort } from '../browser/servers';
import { useLinkTarget } from '../browser/toolbar';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Empty } from '../components/ui/empty';
import { BellIcon, BookIcon, PanelIcon } from '../components/ui/icons';
import { type PathwayState, StatusPill } from '../components/ui/pathway';
import { ResizeHandle, usePanelWidth } from '../components/ui/resize-handle';
import {
  useBrowserTabCount,
  useDeleteSession,
  useEditMessage,
  useLocalServers,
  useMessages,
  useOpenFolder,
  useOutputFiles,
  useProcesses,
  usePushSession,
  useRepoPullRequests,
  useRepoSessions,
  useRepos,
  useRunningProcessCount,
  useSessionDiff,
  useSessionPullRequest,
  useStopSession,
  warmSession,
} from '../lib/queries';
import { useStored } from '../lib/remember';
import { PlaybookLink } from '../playbooks/job-steps';
import { BranchSwitcher } from './branch-switcher';
import { CommitDialog } from './commit-dialog';
import type { ComposerCommand } from './composer-menus';
import { ConversationMap, ScrollToEnd, useFollowLatest } from './conversation';
import { alertPath, pullRequestPath } from './links';
import { OpenPullRequestForm } from './open-pull-request';
import { SessionComposer } from './session-composer';
import { DIFF_PANEL, DiffPanel } from './session-diff';
import { SessionPanel, SubagentWait, type Surface, workingSubagents } from './session-panel';
import { SESSION_STATE_TIP } from './sessions-pane';

// xterm is a third of the page's code, and only an open dock needs it.
const TerminalsDock = lazy(async () => ({ default: (await import('../browser/terminals-dock')).TerminalsDock }));

/** The Session card's size: narrow, as the thread panel of T3 Code, with the conversation keeping the rest. */
const SESSION_PANEL = { key: 'workspace.session-card-width', initial: 380, narrowest: 300, keep: 480 };

const NO_FILES: OutputFile[] = [];
/** The newest messages that always draw in full; older ones are drawn when they near the screen. */
const KEEP_DRAWN = 8;

export function SessionView({ id, onGone }: { id: string; onGone: () => void }) {
  const sessions = useRepoSessions();
  const repos = useRepos();
  const messages = useMessages(id);
  const outputFiles = useOutputFiles(id);
  const outputs = useMemo(
    () => outputsByMessage(messages.data ?? [], outputFiles.data ?? []),
    [messages.data, outputFiles.data],
  );
  const remove = useDeleteSession();
  const { mutateAsync: edit } = useEditMessage(id);
  // What the last edit did to the files, until the operator closes it or sends again.
  const [reverted, setReverted] = useState<EditedMessage | null>(null);
  // One function for every message, so a stream that changes the last one draws only that one.
  const editLast = useCallback(
    (messageId: string, text: string) => edit({ messageId, text }).then((result) => setReverted(result)),
    [edit],
  );
  const latest = useFollowLatest();
  const session = sessions.data?.find((candidate) => candidate.id === id);
  const [diffOpen, setDiffOpen] = useStored('workspace.session-diff-open', z.boolean(), false);
  // The row beside the header; held in state so the panel measures it once it renders.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const panel = usePanelWidth(DIFF_PANEL, body);
  const hasDiff = session?.kind === SessionKind.Repo;
  // The Browser panel and the Terminals dock: for a Session that works in a folder, not a pull request review.
  const hasBrowser = session?.kind === SessionKind.Repo || session?.kind === SessionKind.Anonymous;
  const [browserOpen, setBrowserOpen] = useStored('workspace.session-browser-open', z.boolean(), false);
  const [terminalsOpen, setTerminalsOpen] = useStored('workspace.session-terminals-open', z.boolean(), false);
  const [sessionOpen, setSessionOpen] = useStored('workspace.session-panel-open', z.boolean(), true);
  const browserPanel = usePanelWidth(BROWSER_PANEL, body);
  const sessionPanelWidth = usePanelWidth(SESSION_PANEL, body);
  const [linkTarget] = useLinkTarget();
  // The link the operator last clicked in the conversation, for the panel to open.
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
  const requests = useRef(0);
  const processes = useProcesses(id, hasBrowser);
  // A dot on the Browser button needs the Session's servers, and only while there is no tab to show them in.
  const noTab = useBrowserTabCount(id, hasBrowser) === 0;
  const runningCount = useRunningProcessCount(id, hasBrowser);
  const processRunning = runningCount > 0;
  // While a process runs, the Session's servers are watched so a page opens when one comes up.
  const servers = useLocalServers(
    id,
    hasBrowser && (processRunning || (noTab && !browserOpen) || sessionOpen),
    processRunning,
  );
  // A process started while this view is open gets its page opened when its server listens: the processes there at the
  // start and the ports already opened are skipped.
  const auto = useRef<{ id: string; before: Set<string> | null; opened: Set<number> }>({
    id,
    before: null,
    opened: new Set(),
  });
  if (auto.current.id !== id) auto.current = { id, before: null, opened: new Set() };
  const processList = processes.data;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the processes at the first read are the ones that do not open a page
  useEffect(() => {
    if (processList && auto.current.before === null) auto.current.before = new Set(processList.map((one) => one.id));
  }, [processList, id]);
  const serverList = servers.data;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `openInBrowser` only sets state
  useEffect(() => {
    const { before, opened } = auto.current;
    if (!serverList || before === null) return;
    const fresh = freshServers(serverList, before, opened);
    for (const server of fresh) opened.add(server.port);
    if (fresh[0]) openInBrowser(serverAddress(fresh[0].port));
  }, [serverList]);
  const gone = sessions.isSuccess && session === undefined;
  const stop = useStopSession(id);
  const pulls = useRepoPullRequests(session?.kind === SessionKind.Repo ? session.repo_id : null);
  const sessionState = session?.state;
  const working = sessionState === SessionState.Working || sessionState === SessionState.WaitingApproval;
  // Read again as the agent works, so the Diff button shows once it has edited a file.
  const diff = useSessionDiff(id, hasDiff);
  const openable = useSessionPullRequest(id, hasDiff);
  // The form that opens the pull request, while the operator has it open.
  const [formOpen, setFormOpen] = useState(false);
  // The commit dialog, while the operator has it open.
  const [commitOpen, setCommitOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const push = usePushSession(id);
  const openFolder = useOpenFolder(id);
  // The branch in the Session's own worktree. While the agent works it may make one for its fix; after the run the
  // Session follows it.
  const branch = (working ? diff.data?.branch : null) ?? session?.branch ?? null;
  // The pull request the Session opened for the branch it is on wins; otherwise the open one on the Git host for this
  // branch. Never one that only appears in the conversation, which may be another Session's.
  const listed = pulls.data?.data.find((candidate) => candidate.branch === branch);
  const pull =
    (branch === session?.branch ? session?.pull_request : null) ??
    (listed ? { number: listed.number, url: listed.url } : null);
  // Both ways in: the console's Pull requests tab for the Session's Repo, and the Git host's page.
  const internalPull =
    session?.kind === SessionKind.Repo && session.repo_id !== null && pull !== null
      ? { repo_id: session.repo_id, number: pull.number }
      : null;
  const externalPull = pull;
  // A Session whose worktree changes nothing yet has nothing to show.
  const showDiff = hasDiff && (diff.data?.files.length ?? 0) > 0;
  // The Diff and the Browser share the right column: opening one folds the other, and the Browser wins if both were left open.
  const rightPanel =
    hasBrowser && browserOpen ? 'browser' : showDiff && diffOpen ? 'diff' : sessionOpen ? 'session' : null;
  const toggleDiff = () => {
    setDiffOpen(rightPanel !== 'diff');
    if (rightPanel !== 'diff') {
      setBrowserOpen(false);
      setSessionOpen(false);
    }
  };
  const toggleSession = () => {
    setSessionOpen(rightPanel !== 'session');
    if (rightPanel !== 'session') {
      setBrowserOpen(false);
      setDiffOpen(false);
    }
  };
  const openInBrowser = (url: string) => {
    requests.current += 1;
    setOpenRequest({ id: requests.current, url });
    setBrowserOpen(true);
    setDiffOpen(false);
    setSessionOpen(false);
  };
  // A row of the Session panel: its surface takes the right column; the terminals open in the dock under it.
  const openSurface = (surface: Surface) => {
    if (surface === 'terminal') {
      setTerminalsOpen((now) => !now);
      return;
    }
    setBrowserOpen(surface === 'browser');
    setDiffOpen(surface === 'diff');
    setSessionOpen(false);
  };
  const widths = rightPanel === 'browser' ? browserPanel : rightPanel === 'session' ? sessionPanelWidth : panel;
  const size = rightPanel === 'browser' ? BROWSER_PANEL : rightPanel === 'session' ? SESSION_PANEL : DIFF_PANEL;
  // The `/` menu's actions for this view; the composer adds `skills` and `files`.
  const commands: ComposerCommand[] = [
    ...(working ? [{ name: 'stop', description: 'Stop the agent where it is', run: () => stop.mutate() }] : []),
    ...(showDiff ? [{ name: 'diff', description: 'Show or hide the changed files', run: toggleDiff }] : []),
    ...(openable.data?.can_open && !externalPull && !working
      ? [{ name: 'pr', description: 'Open a pull request for this branch', run: () => setFormOpen(true) }]
      : []),
  ];
  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);
  // Opening a Session that takes messages is a hint one comes soon: the agent can start up meanwhile.
  const takesMessages = hasBrowser;
  useEffect(() => {
    if (takesMessages) warmSession(id);
  }, [id, takesMessages]);

  if (sessions.isPending) return <Empty>Reading the Session…</Empty>;
  if (session === undefined) return null;
  const repo = repos.data?.data.find((candidate) => candidate.id === session.repo_id);
  // The other Repos the operator opened to this Session: folders a process may run in besides its own worktree.
  const runFolders = (repos.data?.data ?? [])
    .filter((one) => session.extra_repo_ids.includes(one.id))
    .map((one) => ({ name: one.name, path: one.path }));
  const busy = working || session.state === SessionState.WaitingInput;
  // Only the last thing the operator asked can be edited and run again.
  const lastAsked = messages.data?.findLast((message) => message.role === 'user')?.id;
  return (
    <BrowserLinksProvider value={hasBrowser && linkTarget === 'app' ? openInBrowser : null}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-2.5 border-b border-line px-6 py-2.5">
          <span className="flex-none text-sm text-neutral-700">{repo ? `${repo.name} /` : 'No Repo /'}</span>
          <h2 className="m-0 min-w-0 truncate text-sm font-semibold" title={session.title}>
            {session.title}
          </h2>
          <span title={SESSION_STATE_TIP[session.state]} className="flex-none">
            <StatusPill state={SESSION_STATE[session.state]}>{session.state.replace('_', ' ')}</StatusPill>
          </span>
          <span className="ml-auto flex flex-none items-center gap-1">
            <Button
              variant="plain"
              aria-pressed={rightPanel === 'session'}
              aria-label="Session"
              title="Session: surfaces, branch, servers and lineage"
              className={`px-2.5 py-1 text-xs ${rightPanel === 'session' ? 'bg-neutral-200' : ''}`}
              onClick={toggleSession}
            >
              <PanelIcon />
              {working && workingSubagents(session.subagents).length > 0 && (
                <span aria-hidden className="size-1.5 rounded-full bg-accent" />
              )}
            </Button>
          </span>
        </header>
        {confirmDelete && (
          <ConfirmDialog
            title="Delete this Session?"
            action="Delete"
            pending={remove.isPending}
            error={remove.isError ? remove.error.message : null}
            onConfirm={() => remove.mutate(id, { onSuccess: () => setConfirmDelete(false) })}
            onCancel={() => setConfirmDelete(false)}
          >
            “{session.title}” and its conversation are deleted. The files in the Repo stay as they are.
          </ConfirmDialog>
        )}
        {commitOpen && (
          <CommitDialog
            sessionId={id}
            branch={branch ?? ''}
            files={openable.data?.uncommitted_files ?? 0}
            additions={diff.data?.additions ?? null}
            deletions={diff.data?.deletions ?? null}
            onClose={() => setCommitOpen(false)}
          />
        )}
        {formOpen && openable.data?.can_open && openable.data.base_branch !== null && (
          <OpenPullRequestForm
            sessionId={id}
            baseBranch={openable.data.base_branch}
            uncommittedFiles={openable.data.uncommitted_files}
            onClose={() => setFormOpen(false)}
          />
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          <div ref={setBody} className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="relative flex min-h-0 flex-1 flex-col">
                <section
                  ref={latest.setScroller}
                  onScroll={latest.onScroll}
                  aria-label="Conversation"
                  className="relative min-h-0 flex-1 overflow-y-auto"
                >
                  <div ref={latest.setContent}>
                    {messages.isPending ? (
                      <Empty>Reading the conversation…</Empty>
                    ) : messages.isError ? (
                      <Empty>Could not read the conversation: {messages.error.message}</Empty>
                    ) : messages.data.length === 0 ? (
                      <Empty>
                        {repo
                          ? `Nothing said yet. Tell the agent what to do on ${session.branch}.`
                          : 'Nothing said yet. This Session has no Repo: it works in a folder of its own. Ask it to clone a repo, or to do anything else.'}
                      </Empty>
                    ) : (
                      <ul className="m-0 list-none px-0 py-2">
                        {messages.data.map((message, index) => (
                          <MessageView
                            key={message.id}
                            message={message}
                            sessionId={id}
                            files={outputs.get(message.id) ?? NO_FILES}
                            editable={message.id === lastAsked && !busy}
                            // Long conversations draw only what is near the screen; the last few always show.
                            deferred={index < messages.data.length - KEEP_DRAWN}
                            onEdit={editLast}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
                <ConversationMap
                  messages={messages.data ?? []}
                  scroller={latest.scroller}
                  content={latest.content}
                  onJump={latest.release}
                />
                <ScrollToEnd show={!latest.atEnd} onClick={latest.scrollToEnd} />
              </div>
              <SubagentWait subagents={session.subagents} stopping={stop.isPending} onStop={() => stop.mutate()} />
              <SessionComposer
                session={session}
                repos={repos.data?.data ?? []}
                lastMessage={messages.data?.at(-1)}
                commands={commands}
                reverted={reverted}
                onSent={() => setReverted(null)}
                onRevertedClose={() => setReverted(null)}
              />
            </div>
            {rightPanel !== null && (
              <>
                <ResizeHandle
                  label={
                    rightPanel === 'browser'
                      ? 'Resize the browser'
                      : rightPanel === 'diff'
                        ? 'Resize the diff panel'
                        : 'Resize the Session panel'
                  }
                  width={widths.width}
                  initial={size.initial}
                  narrowest={size.narrowest}
                  widest={widths.widest}
                  onWidth={widths.setWidth}
                />
                <div style={{ width: widths.width }} className="flex min-h-0 flex-none">
                  {rightPanel === 'browser' ? (
                    <BrowserPanel key={id} sessionId={id} request={openRequest} onClose={() => setBrowserOpen(false)} />
                  ) : rightPanel === 'session' ? (
                    <SessionPanel
                      session={session}
                      branch={branch}
                      pullRequest={
                        pull
                          ? {
                              number: pull.number,
                              href: pull.url,
                              to: internalPull ? pullRequestPath(internalPull.repo_id, internalPull.number) : null,
                            }
                          : null
                      }
                      pullInfo={
                        pull
                          ? (() => {
                              const known = pulls.data?.data.find((candidate) => candidate.number === pull.number);
                              return known ? { title: known.title, checks: known.checks } : null;
                            })()
                          : null
                      }
                      publish={
                        hasDiff && branch
                          ? {
                              uncommitted: openable.data?.uncommitted_files ?? 0,
                              blocked: busy
                                ? 'Wait for the agent to finish'
                                : branch === repo?.default_branch
                                  ? `${branch} is the default branch: change it from your own folder`
                                  : null,
                              canOpenPullRequest: Boolean(openable.data?.can_open && !externalPull) && !busy,
                              onCommit: () => setCommitOpen(true),
                              onPush: () => push.mutate(),
                              onOpenPullRequest: () => setFormOpen(true),
                              pushing: push.isPending,
                              error: push.isError ? push.error.message : null,
                            }
                          : null
                      }
                      branchControl={
                        repo ? (
                          <BranchSwitcher session={session} all={sessions.data ?? []} repo={repo} opens="down" />
                        ) : (
                          <span className="px-2 font-mono text-sm">{branch}</span>
                        )
                      }
                      folder={
                        hasDiff
                          ? {
                              disabled: openFolder.isPending,
                              onEditor: () => openFolder.mutate(FolderTarget.Editor),
                              onFolder: () => openFolder.mutate(FolderTarget.Folder),
                              error: openFolder.isError ? openFolder.error.message : null,
                            }
                          : null
                      }
                      links={
                        session.alert_id || session.playbook ? (
                          <>
                            {session.alert_id && (
                              <Link
                                to={alertPath(session.alert_id)}
                                title="Open the Monitor Alert this Session verifies and fixes"
                                className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-text no-underline hover:bg-neutral-200"
                              >
                                <span className="flex w-4 flex-none justify-center text-neutral-700">
                                  <BellIcon />
                                </span>
                                Alert →
                              </Link>
                            )}
                            {session.playbook && (
                              <div className="flex items-center gap-3 px-3 py-2 text-sm">
                                <span className="flex w-4 flex-none justify-center text-neutral-700">
                                  <BookIcon />
                                </span>
                                <PlaybookLink
                                  playbook={session.playbook}
                                  label={`Playbook: ${session.playbook.name}`}
                                  title="The agent follows this Playbook's rules in every message here. Open it to read or change them."
                                />
                              </div>
                            )}
                          </>
                        ) : null
                      }
                      remove={{
                        disabled: busy || remove.isPending,
                        title: busy
                          ? 'Stop the agent first'
                          : 'Delete this Session and its conversation. The files in the Repo stay as they are.',
                        error: remove.isError ? remove.error.message : null,
                        onDelete: () => setConfirmDelete(true),
                      }}
                      diff={diff.data}
                      servers={servers.data ?? []}
                      hasBrowser={hasBrowser}
                      hasDiff={showDiff}
                      browserPort={noTab ? sessionPort(servers.data ?? []) : null}
                      terminalsRunning={runningCount}
                      terminalsOpen={terminalsOpen}
                      onOpen={openSurface}
                      onOpenServer={(port) => openInBrowser(serverAddress(port))}
                      onClose={() => setSessionOpen(false)}
                    />
                  ) : (
                    <DiffPanel
                      diff={diff.data}
                      error={diff.error?.message ?? null}
                      loading={diff.isPending}
                      fetching={diff.isFetching}
                      onRefresh={() => void diff.refetch()}
                      onClose={() => setDiffOpen(false)}
                    />
                  )}
                </div>
              </>
            )}
          </div>
          {hasBrowser && terminalsOpen && (
            <Suspense fallback={<Empty>Loading the terminals…</Empty>}>
              <TerminalsDock key={id} sessionId={id} folders={runFolders} onClose={() => setTerminalsOpen(false)} />
            </Suspense>
          )}
        </div>
      </div>
    </BrowserLinksProvider>
  );
}

const SESSION_STATE: Record<SessionState, PathwayState> = {
  [SessionState.Idle]: 'pending',
  [SessionState.Working]: 'running',
  [SessionState.WaitingInput]: 'running',
  [SessionState.WaitingApproval]: 'running',
  [SessionState.Failed]: 'failed',
};
