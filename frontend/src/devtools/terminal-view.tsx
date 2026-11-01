import {
  AccessLevel,
  type Connection,
  type Message,
  type Part,
  type Session,
  SessionState,
  sessionDefaultsSchema,
} from '@ops-console/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { ApprovalPrompts } from '../agents/approval-prompts';
import { InlineText } from '../agents/inline-text';
import { SessionChips, SettingsChips } from '../agents/session-chips';
import { BrandIcon, CONNECTION_BRAND } from '../components/ui/brand-icon';
import { Empty } from '../components/ui/empty';
import { item } from '../components/ui/item';
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

const ACCESS: Record<AccessLevel, string> = {
  [AccessLevel.None]: 'Access Level none: set it in Connections',
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
    text: 'Searches every connected dev tool, or only the ones you select on the left. Access follows Connections.',
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
  return (
    <aside
      aria-label="Synced dev tools"
      className="flex w-72 flex-none flex-col gap-0.5 overflow-auto border-r border-line bg-surface/40 px-3 py-4"
    >
      <button
        type="button"
        aria-pressed={scope.length === 0}
        title="Search every connected dev tool. Pick tools below to narrow the search."
        onClick={() => onScope([])}
        className={`flex w-full items-center gap-2.5 px-2.5 py-2 text-xs font-bold ${item(scope.length === 0)}`}
      >
        <span
          aria-hidden
          className={`flex size-6 flex-none items-center justify-center rounded-md ${scope.length === 0 ? 'bg-accent text-white' : 'bg-neutral-200 text-neutral-700'}`}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            aria-hidden
          >
            <path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5" strokeLinejoin="round" />
          </svg>
        </span>
        All connected
        <span className="ml-auto rounded-full bg-neutral-200 px-2 font-mono text-[11px] font-normal text-neutral-700">
          {reachable.length}
        </span>
      </button>
      <div className="mt-3 mb-1 px-2 text-[10px] font-semibold tracking-[0.08em] text-neutral-600 uppercase">
        Connections
      </div>
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
            className={`flex w-full items-center gap-2.5 px-2.5 py-2 ${item(on)}`}
          >
            <span
              aria-hidden
              className={`flex size-4 flex-none items-center justify-center rounded-[5px] border transition-colors ${
                on ? 'border-accent bg-accent text-white' : 'border-neutral-400 bg-card'
              }`}
            >
              {on && (
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden
                >
                  <path d="m2.5 6 2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            <BrandIcon brand={CONNECTION_BRAND[connection.type]} size="sm" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{connection.name}</span>
            {connection.is_prod && (
              <span className="rounded-full bg-accent-100 px-1.75 py-px text-[9px] font-extrabold text-accent-700">
                PROD
              </span>
            )}
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
    <section className="term m-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl shadow-md">
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

const stripArrow =
  'flex size-7 flex-none cursor-pointer items-center justify-center rounded-full border border-line bg-card text-base leading-none text-neutral-700 shadow-sm hover:bg-neutral-200 hover:text-text';

const tabLabel = (session: Session, number: number) =>
  session.title === 'New session' ? `terminal ${number}` : session.title;

export function DevToolsView() {
  const sessions = useDevtoolsSessions();
  const connections = useConnections();
  const askNew = useAskNewDevtoolsSession();
  const remove = useDeleteSession();
  const navigate = useNavigate();
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
  // Which ends of the strip have tabs scrolled out of sight: those ends fade and get an arrow.
  const [edges, setEdges] = useState({ left: false, right: false });
  const measureStrip = () => {
    const el = strip.current;
    if (!el) return;
    const next = { left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 };
    setEdges((now) => (now.left === next.left && now.right === next.right ? now : next));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: measures again when tabs come or go
  useEffect(() => {
    measureStrip();
    const el = strip.current;
    if (!el) return;
    const observer = new ResizeObserver(measureStrip);
    observer.observe(el);
    return () => observer.disconnect();
  }, [sessions.data, drafts.length]);
  const scrollStrip = (by: number) => strip.current?.scrollBy({ left: by, behavior: 'smooth' });

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
          onClick={() => navigate('/connections')}
          className="cursor-pointer border-0 bg-transparent p-0 text-accent underline"
        >
          Add one in Connections
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
    `flex flex-none items-center gap-0.5 font-mono text-xs ${item(selected)} ${selected ? 'font-bold' : ''}`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <SyncedTools connections={all} scope={scope} onScope={setScope} />
      <section className="flex min-h-0 min-w-0 flex-[999_1_520px] flex-col">
        <div className="flex items-center gap-1 border-b border-line py-1.5 pr-2 pl-2">
          {edges.left && (
            <button
              type="button"
              aria-label="Scroll terminals left"
              onClick={() => scrollStrip(-240)}
              className={stripArrow}
            >
              ‹
            </button>
          )}
          <div
            ref={strip}
            role="tablist"
            aria-label="Terminals"
            onScroll={measureStrip}
            onWheel={(event) => {
              // A mouse wheel scrolls the strip sideways; it has no vertical scroll of its own.
              if (strip.current && event.deltaY !== 0) strip.current.scrollLeft += event.deltaY;
            }}
            style={{
              maskImage: `linear-gradient(to right, ${edges.left ? 'transparent, black 28px' : 'black, black'}, ${
                edges.right ? 'black calc(100% - 28px), transparent' : 'black, black'
              })`,
            }}
            className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {tabs.map((candidate, index) => {
              const label = tabLabel(candidate, index + 1);
              const selected = candidate.id === session?.id;
              return (
                <div key={candidate.id} className={tab(selected)}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    title={candidate.title}
                    onClick={() => setPicked(candidate.id)}
                    className="max-w-44 cursor-pointer truncate border-0 bg-transparent py-1.5 pl-3 font-[inherit] text-inherit"
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
                    className="mr-1 flex size-5 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-neutral-600 hover:bg-neutral-300 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {draftTabs.map((candidate) => {
              const selected = candidate.id === draft?.id;
              return (
                <div key={candidate.id} className={tab(selected)}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setPicked(candidate.id)}
                    className="cursor-pointer border-0 bg-transparent py-1.5 pl-3 font-[inherit] text-inherit"
                  >
                    new terminal
                  </button>
                  <button
                    type="button"
                    aria-label="Close new terminal"
                    title="Close this terminal"
                    disabled={askingFrom === candidate.id}
                    onClick={() => closeDraft(candidate.id)}
                    className="mr-1 flex size-5 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-neutral-600 hover:bg-neutral-300 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          {edges.right && (
            <button
              type="button"
              aria-label="Scroll terminals right"
              onClick={() => scrollStrip(240)}
              className={stripArrow}
            >
              ›
            </button>
          )}
          <button
            type="button"
            aria-label="New terminal"
            title="New terminal"
            onClick={() => {
              const id = `new-${crypto.randomUUID()}`;
              setDrafts((all) => [...all, blankDraft(id)]);
              setPicked(id);
            }}
            className="flex size-7.5 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-base font-extrabold text-accent hover:bg-accent-100"
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
