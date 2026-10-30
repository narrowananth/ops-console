import { type Message, type Part, SessionState } from '@ops-console/shared';
import { useEffect, useState } from 'react';
import { ApprovalPrompts } from '../agents/approval-prompts';
import { SessionChips } from '../agents/session-chips';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import { useDeleteSession, useMessages, useRepoSessions, useSendMessage } from '../lib/queries';
import { BranchSwitcher } from './branch-switcher';

function PartView({ part }: { part: Part }) {
  if (part.kind === 'text') return <p className="m-0 whitespace-pre-wrap text-[13px]">{part.text}</p>;
  if (part.kind === 'step') return <div className="font-mono text-xs text-neutral-700">{part.text}</div>;
  if (part.kind === 'code') {
    return <pre className="m-0 overflow-x-auto bg-surface p-2 font-mono text-xs">{part.text}</pre>;
  }
  if (part.kind === 'diff') {
    return (
      <div className="border border-divider font-mono text-xs">
        <div className="bg-surface px-2 py-1 font-bold">{part.file}</div>
        {part.lines.map((line, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no id
            key={index}
            className={line.sign === '+' ? 'bg-neutral-200' : line.sign === '-' ? 'bg-accent-100 text-accent-700' : ''}
          >
            {line.sign} {line.text}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="border-l-3 border-accent pl-2 text-[13px]">
      <strong>{part.text}</strong>
      {part.options.length > 0 && <div className="text-xs text-neutral-700">{part.options.join(' · ')}</div>}
    </div>
  );
}

function MessageView({ message }: { message: Message }) {
  const agent = message.role === 'agent';
  return (
    <li className={`flex flex-col gap-1.5 px-5 py-3 ${agent ? '' : 'bg-surface'}`}>
      <span className="text-[10px] tracking-[0.08em] text-neutral-700 uppercase">
        {agent ? 'Agent' : 'You'}
        {message.status === 'streaming' && ' · working'}
        {message.status === 'failed' && ' · failed'}
      </span>
      {message.parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts stream in order and never reorder
        <PartView key={index} part={part} />
      ))}
    </li>
  );
}

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
