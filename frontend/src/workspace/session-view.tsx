import { SessionState } from '@ops-console/shared';
import { useEffect, useState } from 'react';
import { ApprovalPrompts } from '../agents/approval-prompts';
import { SessionChips } from '../agents/session-chips';
import { MessageView } from '../agents/transcript';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { useDeleteSession, useMessages, useRepoSessions, useRepos, useSendMessage } from '../lib/queries';
import { BranchSwitcher } from './branch-switcher';

export function SessionView({ id, onGone }: { id: string; onGone: () => void }) {
  const sessions = useRepoSessions();
  const repos = useRepos();
  const messages = useMessages(id);
  const send = useSendMessage(id);
  const remove = useDeleteSession();
  const [text, setText] = useState('');
  const session = sessions.data?.find((candidate) => candidate.id === id);
  const gone = sessions.isSuccess && session === undefined;
  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);

  if (sessions.isPending) return <Empty>Reading the Session…</Empty>;
  if (session === undefined) return null;
  const repo = repos.data?.data.find((candidate) => candidate.id === session.repo_id);
  const running = session.state === SessionState.Working || session.state === SessionState.WaitingApproval;
  const submit = () => {
    if (text.trim() === '' || running) return;
    send.mutate(text, { onSuccess: () => setText('') });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2.5 border-b-2 border-divider px-6 py-3">
        {repo && <span className="text-sm text-neutral-700">{repo.name} /</span>}
        <h2 className="m-0 min-w-0 flex-[1_1_200px] truncate text-base font-extrabold">{session.title}</h2>
        <span className="border border-divider px-2 py-0.5 font-mono text-xs">{session.branch}</span>
        <span className="text-[11px] text-neutral-700">{session.state.replace('_', ' ')}</span>
        <Button
          className="px-2.5 py-1 text-xs"
          disabled={running || remove.isPending}
          onClick={() => remove.mutate(id)}
        >
          Delete
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {messages.isPending ? (
          <Empty>Reading the conversation…</Empty>
        ) : messages.isError ? (
          <Empty>Could not read the conversation: {messages.error.message}</Empty>
        ) : messages.data.length === 0 ? (
          <Empty>Nothing said yet. Tell the agent what to do on {session.branch}.</Empty>
        ) : (
          <ul className="m-0 list-none p-0">
            {messages.data.map((message) => (
              <MessageView key={message.id} message={message} />
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-2 px-6 pb-4.5">
        <ApprovalPrompts sessionId={id} />
        <div className="border-2 border-text bg-bg">
          <textarea
            aria-label="Message"
            value={text}
            disabled={running}
            placeholder={
              running
                ? 'The agent is working…'
                : `Ask anything in ${repo?.name ?? 'this Repo'} — e.g. add a retry to the orders webhook and write a test`
            }
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            className="block max-h-50 min-h-16 w-full resize-y border-0 bg-transparent px-4 pt-3.5 pb-1.5 text-sm text-text outline-none"
          />
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-1.5 pb-2.5">
            <SessionChips session={session} variant="chip" />
            <BranchSwitcher session={session} all={sessions.data ?? []} repo={repo} />
            {send.isError && (
              <span role="alert" className="text-xs text-accent-700">
                {send.error.message}
              </span>
            )}
            <span className="ml-auto text-[11px] text-neutral-600" title="Shift+Enter adds a new line">
              Enter to send
            </span>
            <Button
              variant="primary"
              className="px-3.5 py-1.5"
              disabled={running || text.trim() === '' || send.isPending}
              onClick={submit}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
