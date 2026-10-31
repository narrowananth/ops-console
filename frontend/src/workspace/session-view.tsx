import { SessionState } from '@ops-console/shared';
import { useEffect, useState } from 'react';
import { ApprovalPrompts } from '../agents/approval-prompts';
import { SessionChips } from '../agents/session-chips';
import { MessageView } from '../agents/transcript';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { useDeleteSession, useMessages, useRepoSessions, useSendMessage } from '../lib/queries';
import { BranchSwitcher } from './branch-switcher';

export function SessionView({ id, onGone }: { id: string; onGone: () => void }) {
  const sessions = useRepoSessions();
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
  const running = session.state === SessionState.Working || session.state === SessionState.WaitingApproval;
  const submit = () => {
    if (text.trim() === '' || running) return;
    send.mutate(text, { onSuccess: () => setText('') });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-2 border-b-2 border-divider px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="m-0 min-w-0 flex-1 truncate text-[15px] font-extrabold">{session.title}</h2>
          <Button
            className="px-2.5 py-1 text-xs"
            disabled={running || remove.isPending}
            onClick={() => remove.mutate(id)}
          >
            Delete
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BranchSwitcher session={session} all={sessions.data ?? []} />
          <span className="text-[11px] text-neutral-700">{session.state.replace('_', ' ')}</span>
        </div>
        <SessionChips session={session} />
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
      <div className="flex flex-col gap-2 border-t-2 border-divider px-5 py-3">
        <ApprovalPrompts sessionId={id} />
        <textarea
          aria-label="Message"
          rows={3}
          value={text}
          disabled={running}
          placeholder={running ? 'The agent is working…' : 'Message the agent'}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
          }}
          className="resize-none border-[1.5px] border-text bg-bg px-2 py-1.5 text-[13px] text-text"
        />
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={running || text.trim() === '' || send.isPending} onClick={submit}>
            Send
          </Button>
          {send.isError && (
            <span role="alert" className="text-xs text-accent-700">
              {send.error.message}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
