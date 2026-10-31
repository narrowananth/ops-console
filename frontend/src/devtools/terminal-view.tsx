import { type Session, SessionState } from '@ops-console/shared';
import { useState } from 'react';
import { ApprovalPrompts } from '../agents/approval-prompts';
import { SessionChips } from '../agents/session-chips';
import { MessageView } from '../agents/transcript';
import { useUi } from '../app/ui-store';
import { Button } from '../components/ui/button';
import { Empty } from '../components/ui/empty';
import {
  useConnections,
  useCreateDevtoolsSession,
  useDeleteSession,
  useDevtoolsSessions,
  useMessages,
  useSendMessage,
} from '../lib/queries';
import { ScopePicker } from './scope-picker';

function Terminal({ session }: { session: Session }) {
  const connections = useConnections();
  const messages = useMessages(session.id);
  const send = useSendMessage(session.id);
  const remove = useDeleteSession();
  const [text, setText] = useState('');
  const running = session.state === SessionState.Working || session.state === SessionState.WaitingApproval;
  const submit = () => {
    if (text.trim() === '' || running) return;
    send.mutate(text, { onSuccess: () => setText('') });
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-2 border-b-2 border-divider px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="m-0 min-w-0 flex-1 truncate font-mono text-[14px] font-extrabold">
            ops-agent · dev tools{session.title === 'New session' ? '' : ` · ${session.title}`}
          </h2>
          <span className="text-[11px] text-neutral-700">{session.state.replace('_', ' ')}</span>
          <Button
            className="px-2.5 py-1 text-xs"
            disabled={running || remove.isPending}
            onClick={() => remove.mutate(session.id)}
          >
            Delete
          </Button>
        </div>
        <ScopePicker session={session} connections={connections.data?.data ?? []} />
        <SessionChips session={session} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {messages.isPending ? (
          <Empty>Reading the conversation…</Empty>
        ) : messages.isError ? (
          <Empty>Could not read the conversation: {messages.error.message}</Empty>
        ) : messages.data.length === 0 ? (
          <Empty>Ask about your data: “find shop glowbar”, “show 5 pending reservations”.</Empty>
        ) : (
          <ul className="m-0 list-none p-0">
            {messages.data.map((message) => (
              <MessageView key={message.id} message={message} />
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-2 border-t-2 border-divider px-5 py-3">
        <ApprovalPrompts sessionId={session.id} />
        <textarea
          aria-label="Message"
          rows={3}
          value={text}
          disabled={running}
          placeholder={running ? 'The agent is working…' : 'Ask the agent'}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
          }}
          className="resize-none border-[1.5px] border-text bg-bg px-2 py-1.5 font-mono text-[13px] text-text"
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

export function DevToolsView() {
  const sessions = useDevtoolsSessions();
  const connections = useConnections();
  const create = useCreateDevtoolsSession();
  const openSettings = useUi((state) => state.openSettings);
  const [picked, setPicked] = useState<string | null>(null);

  if (sessions.isPending || connections.isPending) return <Empty>Reading Dev tools…</Empty>;
  if (sessions.isError) return <Empty>Could not read Sessions: {sessions.error.message}</Empty>;
  if ((connections.data?.data.length ?? 0) === 0) {
    return (
      <Empty>
        No Connections yet.{' '}
        <button
          type="button"
          onClick={() => openSettings('dev')}
          className="cursor-pointer border-0 bg-transparent p-0 text-accent underline"
        >
          Add one in Settings › Dev tools
        </button>
        .
      </Empty>
    );
  }
  const open = () => create.mutate([], { onSuccess: (session) => setPicked(session.id) });
  // The newest Session reopens first.
  const session = sessions.data.find((candidate) => candidate.id === picked) ?? sessions.data[0];
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      {session === undefined ? (
        <div className="px-6 py-5">
          <Button variant="primary" disabled={create.isPending} onClick={open}>
            Open terminal
          </Button>
          {create.isError && (
            <span role="alert" className="ml-3 text-xs text-accent-700">
              {create.error.message}
            </span>
          )}
        </div>
      ) : (
        <>
          <div role="tablist" aria-label="Terminals" className="flex border-b-2 border-divider">
            {sessions.data.map((candidate, index) => (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={candidate.id === session.id}
                onClick={() => setPicked(candidate.id)}
                className={`-mb-0.5 cursor-pointer border-0 border-b-3 bg-transparent px-3.5 py-2 font-mono text-xs text-text hover:bg-neutral-200 ${candidate.id === session.id ? 'border-b-accent font-extrabold' : 'border-b-transparent'}`}
              >
                terminal {index + 1}
              </button>
            ))}
            <Button variant="ghost" className="ml-auto px-3 py-1 text-xs" disabled={create.isPending} onClick={open}>
              New terminal
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <Terminal key={session.id} session={session} />
          </div>
        </>
      )}
    </section>
  );
}
