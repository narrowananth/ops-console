import {
  type EditedMessage,
  FILE_TOKEN,
  fileToken,
  namesInText,
  SessionKind,
  SessionState,
  withAttachments,
} from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { ApprovalPrompts } from '../agents/approval-prompts';
import { PlayRun } from '../agents/play-run';
import { QuestionPanel, trailingQuestions } from '../agents/question-panel';
import { SessionChips } from '../agents/session-chips';
import { StopRun } from '../agents/stop-run';
import { MessageView } from '../agents/transcript';
import { AttachmentViewer, type Viewed } from '../components/ui/attachment-viewer';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { type PathwayState, StatusPill } from '../components/ui/pathway';
import {
  useDeleteSession,
  useEditMessage,
  useMessages,
  useRepoPullRequests,
  useRepoSessions,
  useRepos,
  useRunQueue,
  useSendMessage,
  useSessionDiff,
  useSessionPullRequest,
} from '../lib/queries';
import { useStored } from '../lib/remember';
import { PlaybookLink } from '../playbooks/job-steps';
import { AttachButton, filesIn, useAttachments } from './attachments';
import { BranchSwitcher } from './branch-switcher';
import { ConversationMap, ScrollToEnd, useFollowLatest } from './conversation';
import { alertPath, pullRequestNamedIn, pullRequestPath, sessionDraftKey } from './links';
import { MessageEditor, type MessageEditorHandle } from './message-editor';
import { OpenPullRequestForm } from './open-pull-request';
import { DiffPanel, DiffToggle, ResizeHandle, useDiffWidth } from './session-diff';
import { SESSION_STATE_TIP } from './sessions-pane';

export function SessionView({ id, onGone }: { id: string; onGone: () => void }) {
  const sessions = useRepoSessions();
  const repos = useRepos();
  const messages = useMessages(id);
  const send = useSendMessage(id);
  const remove = useDeleteSession();
  const editMessage = useEditMessage(id);
  // What the last edit did to the files, until the operator closes it or sends again.
  const [reverted, setReverted] = useState<EditedMessage | null>(null);
  const [text, setText] = useStored(sessionDraftKey(id), z.string(), '');
  const attachments = useAttachments(id);
  const editor = useRef<MessageEditorHandle>(null);
  // An attached file open over the page.
  const [viewed, setViewed] = useState<Viewed | null>(null);
  // A drag carrying files is over the message box.
  const [dropping, setDropping] = useState(false);
  const latest = useFollowLatest();
  const session = sessions.data?.find((candidate) => candidate.id === id);
  const [diffOpen, setDiffOpen] = useStored('workspace.session-diff-open', z.boolean(), false);
  // The row beside the header; held in state so the panel measures it once it renders.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const panel = useDiffWidth(body);
  const hasDiff = session?.kind === SessionKind.Repo;
  const gone = sessions.isSuccess && session === undefined;
  const pulls = useRepoPullRequests(session?.kind === SessionKind.Repo ? session.repo_id : null);
  // What the operator typed while the agent was working: the daemon keeps it and sends it when the run ends, unless the
  // operator stops the run, which holds it for Send now.
  const queue = useRunQueue(id);
  const sessionState = session?.state;
  const working = sessionState === SessionState.Working || sessionState === SessionState.WaitingApproval;
  const diff = useSessionDiff(id, hasDiff, diffOpen && working);
  const openable = useSessionPullRequest(id, hasDiff);
  // The form that opens the pull request, while the operator has it open.
  const [formOpen, setFormOpen] = useState(false);
  // While the agent works, the branch it has checked out: it may make one for its fix. After the run the Session follows it.
  const branch = (working ? diff.data?.branch : null) ?? session?.branch ?? null;
  // A pull request the agent opened or named here wins over the one on the Session's branch.
  const named = pullRequestNamedIn(messages.data ?? []);
  const listed =
    pulls.data?.data.find((candidate) => candidate.number === named?.number) ??
    pulls.data?.data.find((candidate) => candidate.branch === branch);
  const pullNumber = listed?.number ?? named?.number;
  // Both ways in: the console's Pull requests tab for the Session's Repo, and the Git host's page.
  const internalPull =
    session?.kind === SessionKind.Repo && session.repo_id !== null && pullNumber !== undefined
      ? { repo_id: session.repo_id, number: pullNumber }
      : null;
  const externalPull = listed ? { url: listed.url, number: listed.number } : named;
  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);

  if (sessions.isPending) return <Empty>Reading the Session…</Empty>;
  if (session === undefined) return null;
  const repo = repos.data?.data.find((candidate) => candidate.id === session.repo_id);
  const running = session.state === SessionState.Working || session.state === SessionState.WaitingApproval;
  const queued = session.queued_message;
  // A question waiting on the operator still holds the run: the next message answers it.
  const busy = running || session.state === SessionState.WaitingInput;
  // Only the last thing the operator asked can be edited and run again.
  const lastAsked = messages.data?.findLast((message) => message.role === 'user')?.id;
  // The files whose chips sit in the message, and those saved so far.
  const placed = namesInText(text);
  const files = attachments.saved(placed);
  const uploading = attachments.uploading(placed);
  const empty = text.replace(FILE_TOKEN, '').trim() === '' && files.length === 0;
  const addFiles = (picked: File[]) => editor.current?.insertFiles(attachments.add(picked));
  const lastMessage = messages.data?.at(-1);
  const questions =
    session.state === SessionState.WaitingInput && lastMessage?.role === 'agent'
      ? trailingQuestions(lastMessage.parts)
      : [];
  const submit = () => {
    if (empty || queued !== null || uploading) return;
    setReverted(null);
    if (running) {
      queue.queue.mutate(withAttachments(text, files), {
        onSuccess: () => {
          setText('');
          attachments.remove(placed);
        },
      });
      return;
    }
    send.mutate(withAttachments(text, files), {
      onSuccess: () => {
        setText('');
        attachments.remove(placed);
      },
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-1.5 border-b border-line px-6 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex-none text-sm text-neutral-700">{repo ? `${repo.name} /` : 'No Repo /'}</span>
          <h2 className="m-0 min-w-0 truncate text-sm font-semibold" title={session.title}>
            {session.title}
          </h2>
          <span title={SESSION_STATE_TIP[session.state]} className="flex-none">
            <StatusPill state={SESSION_STATE[session.state]}>{session.state.replace('_', ' ')}</StatusPill>
          </span>
          <span className="ml-auto flex flex-none items-center gap-2">
            {/* A Session whose branch changes nothing yet has nothing to show. */}
            {hasDiff && (diffOpen || (diff.data?.files.length ?? 0) > 0) && (
              <DiffToggle open={diffOpen} diff={diff.data} onToggle={() => setDiffOpen((now) => !now)} />
            )}
            <Button
              className="px-2.5 py-1 text-xs"
              title={
                busy
                  ? 'Stop the agent first'
                  : 'Delete this Session and its conversation. The files in the Repo stay as they are.'
              }
              disabled={busy || remove.isPending}
              onClick={() => remove.mutate(id)}
            >
              Delete
            </Button>
          </span>
        </div>
        {(branch ||
          internalPull ||
          externalPull ||
          session.alert_id ||
          session.playbook ||
          openable.data?.can_open) && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {branch && (
              <span
                title="The branch this Session works on"
                className="max-w-90 truncate rounded-full border border-line bg-card px-2.5 py-0.5 font-mono text-xs"
              >
                {branch}
              </span>
            )}
            {internalPull && (
              <Link
                to={pullRequestPath(internalPull.repo_id, internalPull.number)}
                title={`Open pull request #${internalPull.number} in the Workspace's Pull requests tab`}
                className="rounded-full border border-line bg-card px-2.5 py-0.5 text-xs text-text no-underline hover:border-accent-300 hover:bg-accent-100"
              >
                PR #{internalPull.number} →
              </Link>
            )}
            {externalPull && (
              <a
                href={externalPull.url}
                target="_blank"
                rel="noreferrer"
                title={`Open pull request #${externalPull.number} on the Git host`}
                className="rounded-full border border-line bg-card px-2.5 py-0.5 text-xs text-text no-underline hover:border-accent-300 hover:bg-accent-100"
              >
                #{externalPull.number} on host ↗
              </a>
            )}
            {openable.data?.can_open && !externalPull && (
              <Button
                className="px-2.5 py-0.5 text-xs"
                title={
                  busy
                    ? 'Wait for the agent to finish'
                    : 'Push this branch and open a pull request on the Git host. The agent drafts the text.'
                }
                disabled={busy || formOpen}
                onClick={() => setFormOpen(true)}
              >
                Open pull request
              </Button>
            )}
            {session.alert_id && (
              <Link
                to={alertPath(session.alert_id)}
                title="Open the Monitor Alert this Session verifies and fixes"
                className="rounded-full border border-line bg-card px-2.5 py-0.5 text-xs text-text no-underline hover:border-accent-300 hover:bg-accent-100"
              >
                Alert →
              </Link>
            )}
            {session.playbook && (
              <PlaybookLink
                playbook={session.playbook}
                label={`Playbook: ${session.playbook.name}`}
                title="The agent follows this Playbook's rules in every message here. Open it to read or change them."
              />
            )}
          </div>
        )}
        {remove.isError && (
          <span role="alert" className="text-right text-xs text-accent-700">
            {remove.error.message}
          </span>
        )}
      </header>
      {formOpen && openable.data?.can_open && openable.data.base_branch !== null && (
        <OpenPullRequestForm
          sessionId={id}
          baseBranch={openable.data.base_branch}
          uncommittedFiles={openable.data.uncommitted_files}
          onClose={() => setFormOpen(false)}
        />
      )}
      <div ref={setBody} className="flex min-h-0 flex-1">
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
                    {messages.data.map((message) => (
                      <MessageView
                        key={message.id}
                        message={message}
                        onEdit={
                          message.id === lastAsked && !busy
                            ? (edited) =>
                                editMessage
                                  .mutateAsync({ messageId: message.id, text: edited })
                                  .then((result) => setReverted(result))
                            : undefined
                        }
                      />
                    ))}
                  </ul>
                )}
              </div>
            </section>
            <ConversationMap messages={messages.data ?? []} scroller={latest.scroller} content={latest.content} />
            <ScrollToEnd show={!latest.atEnd} onClick={latest.scrollToEnd} />
          </div>
          <div className="flex flex-col gap-2 px-6 pb-4.5">
            <ApprovalPrompts sessionId={id} />
            {questions.length > 0 && (
              <QuestionPanel
                // A new question set starts at its first question.
                key={questions.map((question) => question.text).join('\n')}
                questions={questions}
                pending={send.isPending}
                onSend={(answer) => send.mutate(answer)}
              />
            )}
            {session.state === SessionState.Failed && session.last_error && (
              <div
                role="alert"
                className="rounded-lg border border-accent-300 bg-accent-100 px-3 py-2 text-accent-900 text-xs"
              >
                {session.last_error}
              </div>
            )}
            {queued !== null && (
              <QueuedNote
                text={queued}
                held={!busy}
                sending={queue.sendNow.isPending}
                onSendNow={() => queue.sendNow.mutate()}
                onCancel={() => {
                  setText((current) => (current.trim() === '' ? queued : `${queued}\n\n${current}`));
                  queue.takeBack.mutate();
                }}
              />
            )}
            {reverted && <RevertNote result={reverted} onClose={() => setReverted(null)} />}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: dropping files is a shortcut; Attach files does the same */}
            <div
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return;
                event.preventDefault();
                setDropping(true);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
              }}
              onDrop={(event) => {
                setDropping(false);
                const files = filesIn(event.dataTransfer);
                if (files.length === 0) return;
                event.preventDefault();
                addFiles(files);
              }}
              className={`rounded-lg border bg-card shadow-sm transition-[border-color,box-shadow] focus-within:border-accent-400 focus-within:shadow-[0_0_0_3px_var(--color-accent-100)] ${dropping ? 'border-dashed border-accent-400 bg-accent-100' : 'border-divider'}`}
            >
              <MessageEditor
                ref={editor}
                label="Message"
                value={text}
                placeholder={
                  running
                    ? 'The agent is working. Type the next message: it sends when the run ends.'
                    : repo
                      ? `Ask anything in ${repo.name} — e.g. add a retry to the orders webhook and write a test`
                      : 'Ask anything — e.g. clone github.com/owner/repo and find why the orders job fails'
                }
                onChange={(next) => {
                  // A chip taken out of the text takes its file with it.
                  const gone = placed.filter((name) => !next.includes(fileToken(name)));
                  if (gone.length > 0) attachments.remove(gone);
                  setText(next);
                }}
                find={attachments.find}
                onOpen={(name) => {
                  const item = attachments.find(name);
                  if (item?.file) setViewed({ name, file: item.file });
                  else if (item?.saved) setViewed({ name, path: item.saved.path });
                }}
                onPasteFiles={addFiles}
                onSubmit={submit}
              />
              <div className="flex items-end gap-1.5 px-2.5 pt-1.5 pb-2.5">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  <AttachButton onFiles={addFiles} />
                  <SessionChips session={session} variant="chip" />
                  {repo && <BranchSwitcher session={session} all={sessions.data ?? []} repo={repo} />}
                  {send.isError && (
                    <span role="alert" className="text-xs text-accent-700">
                      {send.error.message}
                    </span>
                  )}
                </div>
                <span className="flex flex-none items-center gap-1.5">
                  {busy ? <StopRun sessionId={id} className="px-4 py-1.5" /> : <PlayRun sessionId={id} />}
                  <Button
                    variant="primary"
                    title={
                      running
                        ? 'The agent is working. The message waits and sends when the run ends.'
                        : uploading
                          ? 'Waiting for the attached files to upload'
                          : 'Enter sends. Shift+Enter adds a new line.'
                    }
                    className="px-4 py-1.5"
                    disabled={empty || queued !== null || uploading || send.isPending || queue.queue.isPending}
                    onClick={submit}
                  >
                    {running ? 'Queue' : 'Send'}
                  </Button>
                </span>
              </div>
            </div>
          </div>
        </div>
        {viewed && <AttachmentViewer viewed={viewed} onClose={() => setViewed(null)} />}
        {hasDiff && diffOpen && (
          <>
            <ResizeHandle width={panel.width} widest={panel.widest} onWidth={panel.setWidth} />
            <div style={{ width: panel.width }} className="flex min-h-0 flex-none">
              <DiffPanel
                diff={diff.data}
                error={diff.error?.message ?? null}
                loading={diff.isPending}
                fetching={diff.isFetching}
                onRefresh={() => void diff.refetch()}
                onClose={() => setDiffOpen(false)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const SESSION_STATE: Record<SessionState, PathwayState> = {
  [SessionState.Idle]: 'pending',
  [SessionState.Working]: 'running',
  [SessionState.WaitingInput]: 'running',
  [SessionState.WaitingApproval]: 'running',
  [SessionState.Failed]: 'failed',
};

/** The message waiting for the run to end, with a way to take it back. */
function QueuedNote({
  text,
  held,
  sending,
  onSendNow,
  onCancel,
}: {
  text: string;
  /** The operator stopped the run, so the message waits for Send now. */
  held: boolean;
  sending: boolean;
  onSendNow: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg border border-line bg-card px-3 py-2 text-xs">
      <span className="flex-none font-semibold text-neutral-700">{held ? 'On hold' : 'Queued'}</span>
      <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap text-text">{text}</span>
      <button
        type="button"
        disabled={sending}
        onClick={onSendNow}
        title={
          held
            ? 'You stopped the run, so this did not send. Send it now.'
            : 'Stop the run and send this message now instead of waiting for the run to end.'
        }
        className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-text hover:text-accent-700 disabled:cursor-default disabled:opacity-50"
      >
        Send now
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="cursor-pointer border-0 bg-transparent p-0 text-xs text-accent-700 hover:text-accent-600"
      >
        Take back
      </button>
    </div>
  );
}

/** What editing the last message did to the files: the ones put back, or why none were. */
function RevertNote({ result, onClose }: { result: EditedMessage; onClose: () => void }) {
  const { reverted } = result;
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
        reverted ? 'border-line bg-card text-neutral-700' : 'border-accent-200 bg-accent-100 text-accent-900'
      }`}
    >
      <span className="min-w-0 flex-1">
        {reverted === null
          ? `Files not put back: ${result.revert_error}. The edited message ran on the files as they are.`
          : reverted.files.length === 0
            ? 'No files to put back. The edited message runs again.'
            : `Put back ${reverted.files.length} ${reverted.files.length === 1 ? 'file' : 'files'} (+${reverted.insertions} −${reverted.deletions}): ${reverted.files.join(', ')}`}
      </span>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="cursor-pointer border-0 bg-transparent p-0 text-neutral-600 hover:text-text"
      >
        ×
      </button>
    </div>
  );
}
