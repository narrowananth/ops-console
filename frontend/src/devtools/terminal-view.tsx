import {
  AccessLevel,
  type Connection,
  ConnectionType,
  type Message,
  type Part,
  type Session,
  SessionState,
  sessionDefaultsSchema,
} from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApprovalPrompts } from '../agents/approval-prompts';
import { InlineText } from '../agents/inline-text';
import { SessionChips, SettingsChips } from '../agents/session-chips';
import { useUi } from '../app/ui-store';
import { Empty } from '../components/ui/empty';
import {
  useAgentSettings,
  useAskNewDevtoolsSession,
  useConnections,
  useDeleteSession,
  useDevtoolsSessions,
  useMessages,
  useSendMessage,
  useUpdateSession,
} from '../lib/queries';
import { ComparisonView, ResultView } from './result-tables';

const ABBR: Record<ConnectionType, string> = {
  [ConnectionType.Postgres]: 'PG',
  [ConnectionType.Mongodb]: 'MDB',
  [ConnectionType.Redis]: 'RDS',
  [ConnectionType.Clickhouse]: 'CH',
  [ConnectionType.Firebase]: 'FB',
  [ConnectionType.Kafka]: 'KFK',
};

const ACCESS: Record<AccessLevel, string> = {
  [AccessLevel.None]: 'Access Level none: set it in Settings › Dev tools',
  [AccessLevel.Read]: 'read-only',
  [AccessLevel.Write]: 'read / write',
};

const WELCOME = [
  { text: '~ $ ops-agent --dev-tools', className: 'font-semibold' },
  { text: '✻ Dev tools agent · local terminal', className: 'text-neutral-500' },
  {
    text: 'Ask in plain words, e.g. find shop glowbar, or show 5 pending reservations.',
    className: 'text-neutral-500',
  },
  {
    text: 'Searches every connected dev tool, or only the ones you select on the left. Access follows Settings › Dev tools.',
    className: 'text-neutral-500',
  },
];

const isRunning = (session: Session | undefined) =>
  session?.state === SessionState.Working || session?.state === SessionState.WaitingApproval;

/** The Synced dev tools list: picking Connections sets the scope; none picked means every Connection with access. */
function SyncedTools({
  connections,
  scope,
  onScope,
}: {
  connections: Connection[];
  scope: string[];
  onScope: (ids: string[]) => void;
}) {
  const reachable = connections.filter((connection) => connection.access !== AccessLevel.None);
  const row = (on: boolean) =>
    `flex w-full cursor-pointer items-center gap-2 border-0 border-t border-l-3 border-t-neutral-300 px-4 py-2 text-left text-text hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-50 ${
      on ? 'border-l-accent bg-neutral-200' : 'border-l-transparent bg-transparent'
    }`;
  return (
    <aside
      aria-label="Synced dev tools"
      className="flex max-w-70 min-w-50 flex-[1_1_220px] flex-col overflow-auto border-r-2 border-divider"
    >
      <div className="px-4 pt-3.5 pb-1 font-extrabold">Synced dev tools</div>
      <div className="px-4 pb-2.5 text-[11px] text-neutral-700">
        Select tools to narrow the search. With none selected, the agent searches every connected dev tool.
      </div>
      <button
        type="button"
        aria-pressed={scope.length === 0}
        onClick={() => onScope([])}
        className={`${row(scope.length === 0)} text-xs font-bold`}
      >
        All connected
        <span className="ml-auto font-mono text-[11px] font-normal text-neutral-700">{reachable.length}</span>
      </button>
      {connections.map((connection) => {
        const on = scope.includes(connection.id);
        const off = connection.access === AccessLevel.None;
        return (
          <button
            key={connection.id}
            type="button"
            aria-pressed={on}
            disabled={off}
            title={ACCESS[connection.access]}
            onClick={() => onScope(on ? scope.filter((id) => id !== connection.id) : [...scope, connection.id])}
            className={row(on)}
          >
            <span className={`size-2 flex-none border-[1.5px] ${on ? 'border-accent bg-accent' : 'border-text'}`} />
            <span className="w-7.5 flex-none border border-text px-0.5 text-center font-mono text-[9px]">
              {ABBR[connection.type]}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{connection.name}</span>
            {connection.is_prod && <span className="bg-accent px-1 py-px text-[9px] font-extrabold text-bg">PROD</span>}
          </button>
        );
      })}
    </aside>
  );
}

function PartLine({ part, connections }: { part: Part; connections: Connection[] }) {
  if (part.kind === 'result') return <ResultView part={part} connections={connections} />;
  if (part.kind === 'comparison') return <ComparisonView part={part} />;
  if (part.kind === 'step') return <div className="text-neutral-300">● {part.text}</div>;
  if (part.kind === 'text')
    return (
      <div className="whitespace-pre-wrap">
        <InlineText text={part.text} codeClassName="text-accent-300" />
      </div>
    );
  if (part.kind === 'code') return <pre className="m-0 overflow-x-auto pl-4 text-neutral-400">{part.text}</pre>;
  if (part.kind === 'diff') return <div className="text-neutral-300">● edited {part.file}</div>;
  return (
    <div className="font-semibold text-accent-300">
      ? {part.text}
      {part.options.length > 0 && <span className="font-normal text-neutral-400"> ({part.options.join(' · ')})</span>}
    </div>
  );
}

function Lines({ messages, connections }: { messages: Message[]; connections: Connection[] }) {
  return (
    <>
      {messages.map((message) =>
        message.role === 'user' ? (
          <div key={message.id} className="mt-2 font-semibold whitespace-pre-wrap">
            &gt; {message.parts.map((part) => ('text' in part ? part.text : '')).join('\n')}
          </div>
        ) : (
          <div key={message.id} className="flex flex-col gap-0.5">
            {message.parts.map((part, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts stream in order and never reorder
              <PartLine key={index} part={part} connections={connections} />
            ))}
            {message.status === 'streaming' && <div className="text-neutral-500">Working…</div>}
            {message.status === 'failed' && <div className="text-accent-400">✘ The run failed.</div>}
          </div>
        ),
      )}
    </>
  );
}

/** One terminal: the welcome lines, the transcript drawn as terminal lines, and the prompt last. */
function Terminal({
  session,
  connections,
  scopeLabel,
  text,
  onText,
  onAskNew,
  asking,
  askError,
}: {
  session: Session | undefined;
  connections: Connection[];
  scopeLabel: string;
  /** What is typed at the prompt and not sent yet; the view keeps it, so it outlives this terminal's tab. */
  text: string;
  onText: (text: string) => void;
  onAskNew: (text: string, done: () => void) => void;
  asking: boolean;
  askError: string | null;
}) {
  const messages = useMessages(session?.id ?? '');
  const send = useSendMessage(session?.id ?? '');
  const scroller = useRef<HTMLDivElement>(null);
  const prompt = useRef<HTMLInputElement>(null);
  const list = session ? (messages.data ?? []) : [];
  const running = isRunning(session) || asking || send.isPending;
  // Scrolls the terminal only; scrollIntoView would scroll the page under it too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new line
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [list.length, list.at(-1)?.parts.length]);
  // The prompt keeps the cursor, as a terminal does, and gets it back when a run ends.
  useEffect(() => {
    if (!running) prompt.current?.focus();
  }, [running]);

  const submit = () => {
    const question = text.trim();
    if (question === '' || running) return;
    if (session) send.mutate(question, { onSuccess: () => onText('') });
    else onAskNew(question, () => onText(''));
  };
  const error = askError ?? (send.isError ? send.error.message : null);

  return (
    <section className="term flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2.5 border-b border-neutral-700 px-4 py-2 font-mono text-[11px] text-neutral-400">
        <span className="size-1.75 bg-neutral-300" />
        <span className="flex-1">
          ops-agent · dev tools · scope: <span className="text-neutral-100">{scopeLabel}</span>
        </span>
        <span>{session ? session.state.replace('_', ' ') : 'new terminal'}</span>
      </div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a click anywhere in the terminal moves the cursor to the prompt; the prompt itself takes the keys */}
      <div
        ref={scroller}
        onClick={() => {
          if (window.getSelection()?.toString() === '') prompt.current?.focus();
        }}
        className="min-h-0 flex-1 cursor-text overflow-auto px-4 py-3 font-mono text-xs leading-[1.7]"
      >
        {WELCOME.map((line) => (
          <div key={line.text} className={`whitespace-pre-wrap ${line.className}`}>
            {line.text}
          </div>
        ))}
        {session && messages.isError && (
          <div className="text-accent-400">Could not read the conversation: {messages.error.message}</div>
        )}
        <Lines messages={list} connections={connections} />
        {error && <div className="text-accent-400">✘ {error}</div>}
        <div className="mt-1 flex gap-2 text-neutral-100">
          <span className="text-accent-400">&gt;</span>
          <input
            ref={prompt}
            aria-label="Ask the agent"
            aria-busy={running}
            value={text}
            placeholder={
              running ? 'The agent is working…' : 'Ask the agent — e.g. find shop glowbar · show 5 pending reservations'
            }
            onChange={(event) => onText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
            className="flex-1 border-0 bg-transparent font-mono text-xs text-neutral-100 caret-accent-400 outline-none placeholder:text-neutral-600"
          />
        </div>
      </div>
    </section>
  );
}

/**
 * A terminal not yet asked anything: it has no Session until its first question, so it holds the scope and settings
 * picked so far.
 */
const draftSchema = z.object({
  id: z.string(),
  scope: z.array(z.string()),
  settings: sessionDefaultsSchema.partial(),
});
type Draft = z.infer<typeof draftSchema>;

const blankDraft = (id: string): Draft => ({ id, scope: [], settings: {} });

/** The new terminals, the text typed at each prompt and the open tab, kept in this browser across reloads. */
const KEPT_KEY = 'ops-console-devtools-terminals';
const keptSchema = z.object({
  drafts: z.array(draftSchema),
  typed: z.record(z.string(), z.string()),
  picked: z.string().nullable(),
});
type Kept = z.infer<typeof keptSchema>;

function readKept(): Kept {
  try {
    const parsed = keptSchema.safeParse(JSON.parse(localStorage.getItem(KEPT_KEY) ?? 'null'));
    if (parsed.success) return parsed.data;
  } catch {
    // An unreadable entry starts over.
  }
  return { drafts: [], typed: {}, picked: null };
}

const tabLabel = (session: Session, number: number) =>
  session.title === 'New session' ? `terminal ${number}` : session.title;

export function DevToolsView() {
  const sessions = useDevtoolsSessions();
  const connections = useConnections();
  const askNew = useAskNewDevtoolsSession();
  const remove = useDeleteSession();
  const openSettings = useUi((state) => state.openSettings);
  const defaults = useAgentSettings().data?.data.session_defaults;
  // Each `+` opens another new terminal; each stays open, reloads included, until its first question or its `×`.
  const [kept, setKept] = useState(readKept);
  const { drafts, typed, picked } = kept;
  useEffect(() => localStorage.setItem(KEPT_KEY, JSON.stringify(kept)), [kept]);
  const setPicked = (id: string | null) => setKept((now) => ({ ...now, picked: id }));
  const setDrafts = (change: (all: Draft[]) => Draft[]) => setKept((now) => ({ ...now, drafts: change(now.drafts) }));
  const setTyped = (id: string, text: string) =>
    setKept((now) => {
      const { [id]: _sent, ...rest } = now.typed;
      return { ...now, typed: text === '' ? rest : { ...rest, [id]: text } };
    });
  const [askingFrom, setAskingFrom] = useState<string | null>(null);
  // With no Session and no new terminal open, a blank one waits for the first question.
  const draftTabs = drafts.length === 0 && sessions.data?.length === 0 ? [blankDraft('new-0')] : drafts;
  const pickedDraft = draftTabs.find((candidate) => candidate.id === picked);
  // The newest Session reopens first; with none, the newest new terminal.
  const session = pickedDraft
    ? undefined
    : (sessions.data?.find((candidate) => candidate.id === picked) ?? sessions.data?.[0]);
  const draft = pickedDraft ?? (session ? undefined : draftTabs.at(-1));
  const update = useUpdateSession(session?.id ?? '');
  const changeDraft = (id: string, patch: Partial<Omit<Draft, 'id'>>) =>
    setDrafts((all) =>
      all.some((candidate) => candidate.id === id)
        ? all.map((candidate) => (candidate.id === id ? { ...candidate, ...patch } : candidate))
        : [...all, { ...blankDraft(id), ...patch }],
    );
  const closeDraft = (id: string) => {
    setDrafts((all) => all.filter((candidate) => candidate.id !== id));
    setTyped(id, '');
    if (id === draft?.id) setPicked(null);
  };
  const strip = useRef<HTMLDivElement>(null);
  // The picked tab scrolls into the strip; only the strip moves, never the page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the picked terminal changes
  useEffect(() => {
    const picked = strip.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]');
    if (!strip.current || !picked) return;
    const left = picked.offsetLeft - strip.current.offsetLeft;
    if (
      left < strip.current.scrollLeft ||
      left + picked.offsetWidth > strip.current.scrollLeft + strip.current.clientWidth
    )
      strip.current.scrollLeft = left - 24;
  }, [session?.id, draft?.id, sessions.data?.length, drafts.length]);

  if (sessions.isPending || connections.isPending) return <Empty>Reading Dev tools…</Empty>;
  if (sessions.isError) return <Empty>Could not read Sessions: {sessions.error.message}</Empty>;
  if (connections.isError) return <Empty>Could not read Connections: {connections.error.message}</Empty>;
  const all = connections.data.data;
  if (all.length === 0) {
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

  const scope = session ? (session.connection_ids ?? []) : (draft?.scope ?? []);
  const reachable = all.filter((connection) => connection.access !== AccessLevel.None).length;
  const scopeLabel =
    scope.length === 0
      ? `all connected (${reachable})`
      : all
          .filter((connection) => scope.includes(connection.id))
          .map((connection) => connection.name)
          .join(', ');
  const setScope = (ids: string[]) =>
    session ? update.mutate({ connection_ids: ids }) : draft && changeDraft(draft.id, { scope: ids });
  // Oldest on the left, as terminal tabs open.
  const tabs = [...sessions.data].reverse();
  const tab = (selected: boolean) =>
    `-mb-0.5 flex flex-none items-center gap-1.5 border-0 border-b-3 font-mono text-xs ${
      selected ? 'border-b-accent font-extrabold' : 'border-b-transparent'
    }`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <SyncedTools connections={all} scope={scope} onScope={setScope} />
      <section className="flex min-h-0 min-w-0 flex-[999_1_520px] flex-col">
        <div className="flex items-center gap-2 border-b-2 border-divider pr-2">
          <div ref={strip} role="tablist" aria-label="Terminals" className="flex min-w-0 flex-1 overflow-x-auto">
            {tabs.map((candidate, index) => {
              const label = tabLabel(candidate, index + 1);
              const selected = candidate.id === session?.id;
              return (
                <div key={candidate.id} className={`${tab(selected)} hover:bg-neutral-200`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    title={candidate.title}
                    onClick={() => setPicked(candidate.id)}
                    className="max-w-44 cursor-pointer truncate border-0 bg-transparent py-2 pl-3 font-[inherit] text-text"
                  >
                    {label}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${label}`}
                    title="Delete this terminal"
                    disabled={isRunning(candidate) || remove.isPending}
                    onClick={() =>
                      remove.mutate(candidate.id, {
                        onSuccess: () => {
                          setTyped(candidate.id, '');
                          if (selected) setPicked(null);
                        },
                      })
                    }
                    className="cursor-pointer border-0 bg-transparent py-2 pr-2.5 text-neutral-600 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {draftTabs.map((candidate) => {
              const selected = candidate.id === draft?.id;
              return (
                <div key={candidate.id} className={`${tab(selected)} hover:bg-neutral-200`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setPicked(candidate.id)}
                    className="cursor-pointer border-0 bg-transparent py-2 pl-3 font-[inherit] text-text"
                  >
                    new terminal
                  </button>
                  <button
                    type="button"
                    aria-label="Close new terminal"
                    title="Close this terminal"
                    disabled={askingFrom === candidate.id}
                    onClick={() => closeDraft(candidate.id)}
                    className="cursor-pointer border-0 bg-transparent py-2 pr-2.5 text-neutral-600 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            aria-label="New terminal"
            title="New terminal"
            onClick={() => {
              const id = `new-${crypto.randomUUID()}`;
              setDrafts((all) => [...all, blankDraft(id)]);
              setPicked(id);
            }}
            className="flex-none cursor-pointer border-0 bg-transparent px-2 py-1 text-base font-extrabold text-accent hover:bg-neutral-200"
          >
            +
          </button>
          <div className="flex flex-none items-center gap-0.5 border-l border-divider pl-2">
            {session ? (
              <SessionChips session={session} variant="chip" opens="down" />
            ) : (
              defaults &&
              draft && (
                <SettingsChips
                  settings={{ ...defaults, ...draft.settings }}
                  onChange={(patch) => changeDraft(draft.id, { settings: { ...draft.settings, ...patch } })}
                  variant="chip"
                  opens="down"
                />
              )
            )}
          </div>
        </div>
        {(update.isError || remove.isError) && (
          <div role="alert" className="px-4 py-1.5 text-xs text-accent-700">
            {(update.error ?? remove.error)?.message}
          </div>
        )}
        {session && (
          <div className="px-4 empty:hidden">
            <ApprovalPrompts sessionId={session.id} />
          </div>
        )}
        <Terminal
          key={session?.id ?? draft?.id}
          session={session}
          text={typed[session?.id ?? draft?.id ?? ''] ?? ''}
          onText={(text) => setTyped(session?.id ?? draft?.id ?? '', text)}
          connections={all}
          scopeLabel={scopeLabel}
          asking={askNew.isPending && askingFrom === draft?.id}
          askError={askNew.isError && askingFrom === draft?.id ? askNew.error.message : null}
          onAskNew={(text, done) => {
            if (!draft) return;
            setAskingFrom(draft.id);
            askNew.mutate(
              { connectionIds: draft.scope, settings: draft.settings, text },
              {
                onSuccess: (started) => {
                  setDrafts((all) => all.filter((candidate) => candidate.id !== draft.id));
                  setPicked(started.id);
                  done();
                },
              },
            );
          }}
        />
      </section>
    </div>
  );
}
