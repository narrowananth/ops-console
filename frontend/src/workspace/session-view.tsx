import { type EditedMessage, SessionKind, SessionState, withAttachments } from '@ops-console/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { ApprovalPrompts } from '../agents/approval-prompts';
import { QuestionPanel, trailingQuestions } from '../agents/question-panel';
import { SessionChips } from '../agents/session-chips';
import { StopRun } from '../agents/stop-run';
import { MessageView } from '../agents/transcript';
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
  useSendMessage,
  useSessionDiff,
} from '../lib/queries';
import { useStored } from '../lib/remember';
import { PlaybookLink } from '../playbooks/job-steps';
import { AttachButton, AttachmentChips, filesIn, useAttachments } from './attachments';
import { BranchSwitcher } from './branch-switcher';
import { ConversationMap, ScrollToEnd, useFollowLatest } from './conversation';
import { alertPath, pullRequestNamedIn, pullRequestPath, sessionDraftKey } from './links';
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
  // What the operator typed while the agent was working; it goes out when the run ends.
  const [queued, setQueued] = useState<string | null>(null);
  const sessionState = session?.state;
  const working = sessionState === SessionState.Working || sessionState === SessionState.WaitingApproval;
  const diff = useSessionDiff(id, hasDiff, diffOpen && working);
  // The branch checked out now: the agent may have made one for its fix since the Session started.
  const branch = diff.data?.branch ?? session?.branch ?? null;
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
  const { mutate: sendQueued, isPending: sending } = send;
  useEffect(() => {
    if (queued === null || working || sessionState === undefined || sending) return;
    sendQueued(queued, {
      onSuccess: () => setQueued(null),
      // Not sent: the words go back into the box instead of vanishing.
      onError: () => {
        setText((current) => (current.trim() === '' ? queued : `${queued}\n\n${current}`));
        setQueued(null);
      },
    });
  }, [queued, working, sessionState, sending, sendQueued, setText]);

  if (sessions.isPending) return <Empty>Reading the Session…</Empty>;
  if (session === undefined) return null;
  const repo = repos.data?.data.find((candidate) => candidate.id === session.repo_id);
  const running = session.state === SessionState.Working || session.state === SessionState.WaitingApproval;
  // A question waiting on the operator still holds the run: the next message answers it.
  const busy = running || session.state === SessionState.WaitingInput;
  // Only the last thing the operator asked can be edited and run again.
  const lastAsked = messages.data?.findLast((message) => message.role === 'user')?.id;
  const empty = text.trim() === '' && attachments.ready.length === 0;
  const lastMessage = messages.data?.at(-1);
  const questions =
    session.state === SessionState.WaitingInput && lastMessage?.role === 'agent'
      ? trailingQuestions(lastMessage.parts)
      : [];
  const submit = () => {
    if (empty || queued !== null || attachments.uploading) return;
    setReverted(null);
    if (running) {
      setQueued(withAttachments(text, attachments.ready));
      setText('');
      attachments.clear();
      return;
    }
    send.mutate(withAttachments(text, attachments.ready), {
      onSuccess: () => {
        setText('');
        attachments.clear();
      },
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-line px-6 py-3">
        <span className="text-sm text-neutral-700">{repo ? `${repo.name} /` : 'No Repo /'}</span>
        <h2 className="m-0 min-w-0 flex-[1_1_200px] truncate text-base font-semibold">{session.title}</h2>
        {branch && (
          <span
            title="The branch this Session works on"
            className="rounded-full border border-line bg-card px-2.5 py-0.5 font-mono text-xs"
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
        {session.alert_id && (
          <Link
            to={alertPath(session.alert_id)}
            title="Open the Monitor Alert this Session verifies and fixes"
            className="rounded-full border border-line bg-card px-2.5 py-0.5 text-xs text-text no-underline hover:border-accent-300 hover:bg-accent-100"
          >
            Alert →
          </Link>
        )}
        <span title={SESSION_STATE_TIP[session.state]}>
          <StatusPill state={SESSION_STATE[session.state]}>{session.state.replace('_', ' ')}</StatusPill>
        </span>
        {session.playbook && (
          <PlaybookLink
            playbook={session.playbook}
            label={`Playbook: ${session.playbook.name}`}
            title="The agent follows this Playbook's rules in every message here. Open it to read or change them."
          />
        )}
        {hasDiff && <DiffToggle open={diffOpen} diff={diff.data} onToggle={() => setDiffOpen((now) => !now)} />}
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
        {remove.isError && (
          <span role="alert" className="basis-full text-right text-xs text-accent-700">
            {remove.error.message}
          </span>
        )}
      </header>
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
            {queued !== null && (
              <QueuedNote
                text={queued}
                onCancel={() => {
                  setText((current) => (current.trim() === '' ? queued : `${queued}\n\n${current}`));
                  setQueued(null);
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
                attachments.add(files);
              }}
              className={`rounded-lg border bg-card shadow-sm transition-[border-color,box-shadow] focus-within:border-accent-400 focus-within:shadow-[0_0_0_3px_var(--color-accent-100)] ${dropping ? 'border-dashed border-accent-400 bg-accent-100' : 'border-divider'}`}
            >
              <AttachmentChips pending={attachments.pending} onRemove={attachments.remove} />
              <textarea
                aria-label="Message"
                value={text}
                placeholder={
                  running
                    ? 'The agent is working. Type the next message: it sends when the run ends.'
                    : repo
                      ? `Ask anything in ${repo.name} — e.g. add a retry to the orders webhook and write a test`
                      : 'Ask anything — e.g. clone github.com/owner/repo and find why the orders job fails'
                }
                onChange={(event) => setText(event.target.value)}
                onPaste={(event) => {
                  // A pasted screenshot or copied file attaches; pasted text goes in as text.
                  const files = filesIn(event.clipboardData);
                  if (files.length === 0) return;
                  event.preventDefault();
                  attachments.add(files);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submit();
                  }
                }}
                className="block field-sizing-content max-h-[50vh] min-h-28 w-full resize-none overflow-y-auto border-0 bg-transparent px-4 pt-3.5 pb-1.5 text-sm leading-relaxed text-text outline-none"
              />
              <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-1.5 pb-2.5">
                <AttachButton onFiles={attachments.add} />
                <SessionChips session={session} variant="chip" />
                {repo && <BranchSwitcher session={session} all={sessions.data ?? []} repo={repo} />}
                {send.isError && (
                  <span role="alert" className="text-xs text-accent-700">
                    {send.error.message}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1.5">
                  {busy && <StopRun sessionId={id} className="px-4 py-1.5" />}
                  <Button
                    variant="primary"
                    title={
                      running
                        ? 'The agent is working. The message waits and sends when the run ends.'
                        : attachments.uploading
                          ? 'Waiting for the attached files to upload'
                          : 'Enter sends. Shift+Enter adds a new line.'
                    }
                    className="px-4 py-1.5"
                    disabled={empty || queued !== null || attachments.uploading || send.isPending}
                    onClick={submit}
                  >
                    {running ? 'Queue' : 'Send'}
                  </Button>
                </span>
              </div>
            </div>
          </div>
        </div>
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
function QueuedNote({ text, onCancel }: { text: string; onCancel: () => void }) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg border border-line bg-card px-3 py-2 text-xs">
      <span className="flex-none font-semibold text-neutral-700">Queued</span>
      <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap text-text">{text}</span>
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
