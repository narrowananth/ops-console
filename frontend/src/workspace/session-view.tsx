import { type EditedMessage, SessionKind, SessionState } from '@ops-console/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { ApprovalPrompts } from '../agents/approval-prompts';
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
} from '../lib/queries';
import { useStored } from '../lib/remember';
import { PlaybookLink } from '../playbooks/job-steps';
import { BranchSwitcher } from './branch-switcher';
import { ConversationMap, useFollowLatest } from './conversation';
import { alertPath, pullRequestPath, sessionDraftKey } from './links';

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
  const latest = useFollowLatest();
  const session = sessions.data?.find((candidate) => candidate.id === id);
  const gone = sessions.isSuccess && session === undefined;
  const pulls = useRepoPullRequests(session?.kind === SessionKind.Repo ? session.repo_id : null);
  const pull = pulls.data?.data.find((candidate) => candidate.branch === session?.branch);
  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);

  if (sessions.isPending) return <Empty>Reading the Session…</Empty>;
  if (session === undefined) return null;
  const repo = repos.data?.data.find((candidate) => candidate.id === session.repo_id);
  const running = session.state === SessionState.Working || session.state === SessionState.WaitingApproval;
  // A question waiting on the operator still holds the run: the next message answers it.
  const busy = running || session.state === SessionState.WaitingInput;
  // Only the last thing the operator asked can be edited and run again.
  const lastAsked = messages.data?.findLast((message) => message.role === 'user')?.id;
  const submit = () => {
    if (text.trim() === '' || running) return;
    setReverted(null);
    send.mutate(text, { onSuccess: () => setText('') });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-line px-6 py-3">
        <span className="text-sm text-neutral-700">{repo ? `${repo.name} /` : 'No Repo /'}</span>
        <h2 className="m-0 min-w-0 flex-[1_1_200px] truncate text-base font-extrabold">{session.title}</h2>
        {session.branch && (
          <span className="rounded-full border border-line bg-card px-2.5 py-0.5 font-mono text-xs">
            {session.branch}
          </span>
        )}
        {pull?.repo_id && (
          <Link
            to={pullRequestPath(pull.repo_id, pull.number)}
            title={`Open pull request #${pull.number}: ${pull.title}`}
            className="rounded-full border border-line bg-card px-2.5 py-0.5 text-xs text-text no-underline hover:border-accent-300 hover:bg-accent-100"
          >
            PR #{pull.number} →
          </Link>
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
        <StatusPill state={SESSION_STATE[session.state]}>{session.state.replace('_', ' ')}</StatusPill>
        {session.playbook && (
          <PlaybookLink
            playbook={session.playbook}
            label={`Playbook: ${session.playbook.name}`}
            title="Rules in this Session come from this Playbook"
          />
        )}
        <Button
          className="px-2.5 py-1 text-xs"
          title={busy ? 'Stop the agent first' : undefined}
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
      </div>
      <div className="flex flex-col gap-2 px-6 pb-4.5">
        <ApprovalPrompts sessionId={id} />
        {reverted && <RevertNote result={reverted} onClose={() => setReverted(null)} />}
        <div className="rounded-lg border border-divider bg-card shadow-sm transition-[border-color,box-shadow] focus-within:border-accent-400 focus-within:shadow-[0_0_0_3px_var(--color-accent-100)]">
          <textarea
            aria-label="Message"
            value={text}
            disabled={running}
            placeholder={
              running
                ? 'The agent is working…'
                : repo
                  ? `Ask anything in ${repo.name} — e.g. add a retry to the orders webhook and write a test`
                  : 'Ask anything — e.g. clone github.com/owner/repo and find why the orders job fails'
            }
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            className="block max-h-50 min-h-16 w-full resize-none border-0 bg-transparent px-4 pt-3.5 pb-1.5 text-sm text-text outline-none"
          />
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-1.5 pb-2.5">
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
                title="Enter sends. Shift+Enter adds a new line."
                className="px-4 py-1.5"
                disabled={running || text.trim() === '' || send.isPending}
                onClick={submit}
              >
                Send
              </Button>
            </span>
          </div>
        </div>
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
