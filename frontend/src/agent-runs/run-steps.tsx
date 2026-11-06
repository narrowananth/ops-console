import { type AgentRun, RunPhase, type RunStep } from '@ops-console/shared';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { CodeBlock } from '../components/ui/code-block';
import { duration } from '../components/ui/elapsed';
import { clock as clockOf } from './run-look';
import type { RunClock } from './run-model';
import { baseName, Heading, plural, shown } from './run-parts';

/** Rows a list shows before "Show all". */
const SHOWN = 12;

type Row = {
  id: string;
  /** Every step the row stands for: a run of reads is one row. */
  ids: string[];
  agentId: string | null;
  at: string;
  ms: number;
  running: boolean;
  tone: 'plain' | 'bad';
  error: string | null;
  text: ReactNode;
  /** The whole of what was run or read, for the expanded block. */
  raw: string;
  steps: number;
};

const tookMs = (step: RunStep, now: number) =>
  (step.finished_at ? Date.parse(step.finished_at) : now) - Date.parse(step.started_at);

/** What a file call touched: the name only, the rest of the path is in the raw block. */
const subjectOf = (step: RunStep) => baseName(step.summary.replace(/^\S+\s/, ''));

/** The commands of a compound shell line, split on `;` and `&&` outside quotes. */
export function commandsOf(command: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let current = '';
  for (let index = 0; index < command.length; index++) {
    const char = command[index] as string;
    if (quote) {
      if (char === quote) quote = null;
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ';' || (char === '&' && command[index + 1] === '&')) {
      if (char === '&') index++;
      if (current.trim()) out.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The calls in the order made, with a run of reads or of edits by one agent joined into one row. */
export function rowsOf(steps: RunStep[], now: number): Row[] {
  const rows: Row[] = [];
  let group: RunStep[] = [];
  const flush = () => {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) return;
    const verb = first.phase === RunPhase.Editing ? 'Edited' : 'Read';
    const names = [...new Set(group.map(subjectOf))];
    const more = names.length - 2;
    rows.push({
      id: first.id,
      ids: group.map((one) => one.id),
      agentId: first.agent_id,
      at: first.started_at,
      ms: (last.finished_at ? Date.parse(last.finished_at) : now) - Date.parse(first.started_at),
      running: last.finished_at === null,
      tone: 'plain',
      error: null,
      steps: group.length,
      raw: group.map((one) => one.summary.replace(/^\S+\s/, '')).join('\n'),
      text: (
        <>
          {verb}{' '}
          {names.slice(0, 2).map((name, index) => (
            <span key={name}>
              {index > 0 && ', '}
              <code className="font-mono text-[11px]">{name}</code>
            </span>
          ))}
          {more > 0 && ` and ${more} more`}
        </>
      ),
    });
    group = [];
  };
  for (const step of steps) {
    const joins =
      (step.phase === RunPhase.Reading || step.phase === RunPhase.Editing) &&
      step.ok !== false &&
      step.tool !== 'Agent' &&
      step.tool !== 'Task';
    const head = group[0];
    if (joins && head && head.phase === step.phase && head.agent_id === step.agent_id) {
      group.push(step);
      continue;
    }
    flush();
    if (joins) {
      group = [step];
      continue;
    }
    const command = step.summary.startsWith('$ ');
    const parts = command ? commandsOf(shown(step.summary)) : [];
    const extra = parts.length - 1;
    rows.push({
      id: step.id,
      ids: [step.id],
      agentId: step.agent_id,
      at: step.started_at,
      ms: tookMs(step, now),
      running: step.finished_at === null,
      tone: step.ok === false ? 'bad' : 'plain',
      error: step.error,
      steps: 1,
      raw: shown(step.summary),
      text: (
        <>
          {command ? 'Ran ' : ''}
          <code className="font-mono text-[11px]">
            {command ? (parts[0] ?? shown(step.summary)) : shown(step.summary)}
          </code>
          {extra > 0 && (
            <span className="text-neutral-700">
              {' '}
              (+{extra} more {extra === 1 ? 'command' : 'commands'})
            </span>
          )}
        </>
      ),
    });
  }
  flush();
  return rows;
}

const MAIN = 'main';
const keyOf = (agentId: string | null) => agentId ?? MAIN;

/** One step row: time, what it did in plain words on one line, how long. Opens to the raw command and the error. */
function StepRow({
  row,
  open,
  onToggle,
  hot,
  lit,
  who,
}: {
  row: Row;
  open: boolean;
  onToggle: () => void;
  hot: boolean;
  lit: boolean;
  who: string | null;
}) {
  const tone = row.tone === 'bad' ? 'bad' : hot || row.running ? 'warm' : 'plain';
  return (
    <li
      id={`step-${row.id}`}
      data-step-ids={row.ids.join(' ')}
      className={`relative my-1 rounded-lg text-[12px] ${
        tone === 'bad' ? 'bg-accent-100' : tone === 'warm' ? 'bg-warn/10' : ''
      } ${lit ? 'outline-2 outline-info' : ''}`}
    >
      <span
        aria-hidden
        className={`absolute top-3 -left-6 size-2.5 rounded-full border-2 border-card ${tone === 'bad' ? 'bg-accent' : tone === 'warm' ? 'bg-warn' : 'bg-neutral-400'} ${row.running ? 'animate-pulse' : ''}`}
      />
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="grid w-full cursor-pointer grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border-0 bg-transparent px-3 py-1.5 text-left font-[inherit] text-[inherit] text-text"
      >
        <span className="font-mono text-[10.5px] whitespace-nowrap text-neutral-700 tabular-nums">
          {clockOf(row.at)}
        </span>
        <span className="truncate">
          {row.text}
          {who && <span className="ml-1.5 text-neutral-700">· {who}</span>}
          {row.steps > 1 && <span className="ml-1.5 text-neutral-700">({row.steps} calls)</span>}
          {row.error && !open && <span className="ml-1.5 text-accent-700">· {row.error}</span>}
        </span>
        <span
          className={`font-mono text-[11px] tabular-nums ${tone === 'bad' ? 'font-bold text-accent-700' : tone === 'warm' ? 'font-bold text-warn' : ''}`}
        >
          {duration(row.ms)}
          {row.running ? ' ●' : ''}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2 pl-[5.75rem]">
          {row.error && <p className="m-0 mb-1 text-[11.5px] break-words text-accent-700">{row.error}</p>}
          <CodeBlock
            text={row.raw}
            className="m-0 max-h-60 overflow-auto rounded-md bg-neutral-900 py-2 pl-3 font-mono text-[11px] break-all whitespace-pre-wrap text-neutral-100"
          />
        </div>
      )}
    </li>
  );
}

/**
 * Every call the agent made. By agent, each in a fold with its count, or in one list in time order. A failed step shows
 * open and the rest closed; what the operator opened stays open while the list updates.
 */
export function Steps({
  run,
  clock,
  steps,
  agent,
  onAgent,
  reveal,
}: {
  run: AgentRun;
  clock: RunClock | null;
  steps: RunStep[];
  agent: string | null;
  onAgent: (id: string | null) => void;
  reveal: { id: string; n: number } | null;
}) {
  const [by, setBy] = useState<'agent' | 'time'>('agent');
  const [query, setQuery] = useState('');
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [everything, setEverything] = useState<Record<string, boolean>>({});
  const [lit, setLit] = useState<string | null>(null);
  const handled = useRef(0);
  const now = clock?.now ?? Date.now();
  const names = useMemo(
    () => new Map((clock?.lanes ?? []).map((lane) => [keyOf(lane.id), lane.label])),
    [clock?.lanes],
  );

  const needle = query.trim().toLowerCase();
  const kept = steps.filter(
    (step) =>
      (agent === null || step.agent_id === agent) &&
      (needle === '' || `${step.summary} ${step.error ?? ''} ${step.tool}`.toLowerCase().includes(needle)),
  );
  const all = useMemo(() => rowsOf(kept, now), [kept, now]);
  const groups = useMemo(() => {
    const order = [MAIN, ...(clock?.lanes.slice(1).map((lane) => keyOf(lane.id)) ?? [])];
    const keys = [...new Set([...order, ...all.map((row) => keyOf(row.agentId))])];
    return keys
      .map((key) => ({ key, rows: all.filter((row) => keyOf(row.agentId) === key) }))
      .filter((group) => group.rows.length > 0);
  }, [all, clock?.lanes]);
  const slowest = all.reduce((best, row) => (row.ms > best.ms ? row : best), all[0] as Row);

  useEffect(() => {
    if (!reveal || handled.current === reveal.n) return;
    const row = rowsOf(steps, now).find((one) => one.ids.includes(reveal.id));
    if (!row) return;
    handled.current = reveal.n;
    setQuery('');
    setOpenGroups((open) => ({ ...open, [keyOf(row.agentId)]: true }));
    setEverything((open) => ({ ...open, [keyOf(row.agentId)]: true, time: true }));
    setOpenRows((open) => ({ ...open, [row.id]: true }));
    setLit(row.id);
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document.getElementById(`step-${row.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
      ),
    );
    const timer = setTimeout(() => setLit(null), 2500);
    return () => clearTimeout(timer);
  }, [reveal, steps, now]);

  if (steps.length === 0) return null;
  const isOpen = (row: Row) => openRows[row.id] ?? row.tone === 'bad';
  const toggle = (row: Row) => setOpenRows((open) => ({ ...open, [row.id]: !isOpen(row) }));
  const rowView = (row: Row, who: string | null) => (
    <StepRow
      key={row.id}
      row={row}
      open={isOpen(row)}
      onToggle={() => toggle(row)}
      hot={row.id === slowest?.id && row.ms >= 60_000}
      lit={lit === row.id}
      who={who}
    />
  );
  const list = (rows: Row[], key: string, who: boolean) => {
    const cut = !everything[key] && rows.length > SHOWN;
    return (
      <>
        <ol className="m-0 list-none border-l-2 border-line p-0 pl-4">
          {(cut ? rows.slice(-SHOWN) : rows).map((row) =>
            rowView(row, who ? (names.get(keyOf(row.agentId)) ?? null) : null),
          )}
        </ol>
        {rows.length > SHOWN && (
          <button
            type="button"
            onClick={() => setEverything((now) => ({ ...now, [key]: !now[key] }))}
            className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-xs text-accent-700"
          >
            {cut ? `Show all ${rows.length}` : `Show the last ${SHOWN}`}
          </button>
        )}
      </>
    );
  };
  const failedIn = (key: string) => steps.some((step) => keyOf(step.agent_id) === key && step.ok === false);
  const picked = agent === null ? null : (names.get(agent) ?? 'one subagent');
  const pill = (id: 'agent' | 'time', text: string) => (
    <button
      type="button"
      aria-pressed={by === id}
      onClick={() => setBy(id)}
      className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] ${
        by === id ? 'border-text bg-text text-card' : 'border-divider bg-card hover:bg-neutral-200'
      }`}
    >
      {text}
    </button>
  );
  return (
    <section className="mb-2">
      <Heading
        note={
          kept.length === steps.length
            ? plural(steps.length, 'call')
            : `${kept.length} of ${plural(steps.length, 'call')}`
        }
      >
        Steps
      </Heading>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search steps: file, command, error"
          aria-label="Search steps"
          className="min-w-56 flex-1 rounded-full border border-divider bg-card px-3 py-1 text-xs"
        />
        <fieldset aria-label="Group steps" className="m-0 flex gap-1 border-0 p-0">
          {pill('agent', 'By agent')}
          {pill('time', 'In time order')}
        </fieldset>
        {picked && (
          <button
            type="button"
            onClick={() => onAgent(null)}
            title="Show the steps of every agent"
            className="cursor-pointer rounded-full border border-info/40 bg-info/10 px-2.5 py-0.5 text-[11px] text-info"
          >
            Only {picked} ✕
          </button>
        )}
      </div>
      {all.length === 0 && <p className="m-0 text-xs text-neutral-700">No step matches.</p>}
      {by === 'time' ? (
        list(all, 'time', run.subagents.length > 0)
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((group) => {
            const open = openGroups[group.key] ?? (group.key === MAIN || failedIn(group.key) || agent !== null);
            const count = group.rows.reduce((sum, row) => sum + row.steps, 0);
            const name = names.get(group.key) ?? 'Subagent';
            return (
              <div key={group.key} className="rounded-xl border border-line bg-card px-3 py-2">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenGroups((now) => ({ ...now, [group.key]: !open }))}
                  className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-[12.5px] font-semibold text-text"
                >
                  <span
                    aria-hidden
                    className={`inline-block text-neutral-700 transition-transform ${open ? 'rotate-90' : ''}`}
                  >
                    ›
                  </span>
                  <span className="min-w-0 truncate" title={name}>
                    {name} ({plural(count, 'step')})
                  </span>
                  {failedIn(group.key) && (
                    <span className="rounded-full bg-accent-100 px-2 font-mono text-[10.5px] text-accent-700">
                      failed
                    </span>
                  )}
                </button>
                {open && <div className="mt-2">{list(group.rows, group.key, false)}</div>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
