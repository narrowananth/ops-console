import {
  type AgentRun,
  headlineOf,
  type Lane,
  percentages,
  RunOutcome,
  RunPhase,
  SubagentStatus,
  type TokenCounts,
} from '@ops-console/shared';
import { useState } from 'react';
import { duration } from '../components/ui/elapsed';
import { legendMs, money, PHASE, PHASES, tokens } from './run-look';
import type { RunClock } from './run-model';
import { Heading, plural, Ring } from './run-parts';

/** Subagents the table lists before "Show all". */
const TABLE_SHOWN = 8;

/** The phases a legend lists: the five always, Subagents and Waiting on limit when they hold time or the run hit a limit. */
function legendPhases(run: AgentRun, split: { phase: RunPhase; ms: number }[]) {
  return split.filter((part) => {
    if (part.phase === RunPhase.Subagents) return part.ms > 0;
    if (part.phase === RunPhase.WaitingLimit) return part.ms > 0 || run.outcome === RunOutcome.RateLimited || run.limit;
    return true;
  });
}

/** Where the time went: a headline, one bar, and a legend of each phase with its time. */
export function Split({ run, clock }: { run: AgentRun; clock: RunClock }) {
  const split = clock.main?.split ?? [];
  const total = clock.total;
  if (total <= 0) return null;
  const legend = legendPhases(run, split);
  const pct = percentages(split.map((part) => part.ms));
  const headline = headlineOf({ split, longestStepMs: clock.longestStepMs, subagentCount: run.subagents.length });
  return (
    <section className="mb-5">
      <Heading note={headline ?? undefined}>Where the {duration(total)} went</Heading>
      <div className="flex h-6 gap-0.5 overflow-hidden rounded-full bg-neutral-200">
        {split
          .filter((part) => part.ms > 0)
          .map((part) => (
            <span
              key={part.phase}
              title={`${PHASE[part.phase].label}: ${legendMs(part.ms)} (${pct[PHASES.indexOf(part.phase)]}%)`}
              className="block h-full rounded-full"
              style={{ width: `${(part.ms / total) * 100}%`, minWidth: 2, background: PHASE[part.phase].color }}
            />
          ))}
      </div>
      <ul
        data-testid="legend"
        className="m-0 mt-3 grid list-none grid-cols-3 gap-x-8 gap-y-1.5 p-0 text-xs max-[760px]:grid-cols-1"
      >
        {legend.map((part) => (
          <li
            key={part.phase}
            title={`${pct[PHASES.indexOf(part.phase)]}% of the run`}
            className="flex items-center gap-2 text-neutral-800"
          >
            <span
              aria-hidden
              className="size-2.5 flex-none rounded-full"
              style={{ background: PHASE[part.phase].color }}
            />
            {PHASE[part.phase].label}
            <span className="ml-auto font-mono text-text tabular-nums">{legendMs(part.ms)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATUS_TONE: Record<SubagentStatus | 'main', string> = {
  main: 'bg-neutral-200 text-neutral-700',
  [SubagentStatus.Working]: 'bg-info/14 text-info',
  [SubagentStatus.Done]: 'bg-ok/12 text-ok',
  [SubagentStatus.Failed]: 'bg-accent-100 text-accent-700',
  [SubagentStatus.Stopped]: 'bg-neutral-200 text-neutral-700',
};

/** The icon before a lane or row: a check, a cross, or a ring that turns. */
export function StatusIcon({ status, running = false }: { status: Lane['status']; running?: boolean }) {
  if (status === SubagentStatus.Working || (status === 'main' && running)) return <Ring className="text-info" />;
  if (status === SubagentStatus.Done) return <span className="flex-none text-[11px] font-bold text-ok">✓</span>;
  if (status === SubagentStatus.Failed)
    return <span className="flex-none text-[11px] font-bold text-accent-700">✗</span>;
  if (status === SubagentStatus.Stopped) return <span className="flex-none text-[10px] text-neutral-700">■</span>;
  return null;
}

const sum = (t: TokenCounts) => t.input + t.output + t.cache_read + t.cache_write;

/** One row a subagent: its name, status, time, where its time went, and what it used. Click filters the steps to it. */
export function SubagentTable({
  run,
  clock,
  filter,
  onFilter,
}: {
  run: AgentRun;
  clock: RunClock;
  filter: string | null;
  onFilter: (id: string | null) => void;
}) {
  const [all, setAll] = useState(false);
  const lanes = clock.lanes.slice(1).sort((a, b) => b.end - b.start - (a.end - a.start));
  if (lanes.length === 0) return null;
  const list = all ? lanes : lanes.slice(0, TABLE_SHOWN);
  return (
    <section className="mb-5">
      <Heading note="longest first. Click one to list only its steps">{plural(lanes.length, 'subagent')}</Heading>
      <div className="overflow-hidden rounded-xl border border-line bg-card">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-left font-mono text-[10px] tracking-wider text-neutral-700 uppercase">
              <th className="px-3 py-1.5 font-normal">Subagent</th>
              <th className="px-2 py-1.5 font-normal">Status</th>
              <th className="px-2 py-1.5 text-right font-normal">Time</th>
              <th className="w-[26%] px-2 py-1.5 font-normal max-[760px]:hidden">Where it went</th>
              <th className="px-3 py-1.5 text-right font-normal">Tokens and cost</th>
            </tr>
          </thead>
          <tbody>
            {list.map((lane) => {
              const used = run.usage?.by_agent.find((one) => one.agent_id === lane.id);
              const span = lane.end - lane.start;
              const status = lane.status === 'main' ? SubagentStatus.Done : lane.status;
              const picked = filter === lane.id;
              return (
                <tr
                  key={lane.id}
                  aria-selected={picked}
                  onClick={() => onFilter(picked ? null : lane.id)}
                  className={`cursor-pointer border-t border-line hover:bg-neutral-100 ${picked ? 'bg-info/[0.08]' : ''}`}
                >
                  <td className="px-3 py-1.5" title={lane.label}>
                    <button
                      type="button"
                      aria-pressed={picked}
                      onClick={(event) => {
                        event.stopPropagation();
                        onFilter(picked ? null : lane.id);
                      }}
                      style={{ paddingLeft: (lane.depth - 1) * 12 }}
                      className="flex max-w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-xs font-semibold text-text"
                    >
                      <StatusIcon status={lane.status} />
                      <span className="truncate">{lane.label}</span>
                    </button>
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={`rounded-full px-2 py-px font-mono text-[10.5px] ${STATUS_TONE[status]}`}>
                      {status}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{duration(span)}</td>
                  <td className="px-2 py-1.5 max-[760px]:hidden" aria-hidden>
                    <div className="flex h-2 gap-px overflow-hidden rounded-full bg-neutral-200">
                      {lane.split
                        .filter((part) => part.ms > 0)
                        .map((part) => (
                          <span
                            key={part.phase}
                            title={`${PHASE[part.phase].label}: ${legendMs(part.ms)}`}
                            className="block h-full"
                            style={{
                              width: `${(part.ms / Math.max(1, span)) * 100}%`,
                              minWidth: 2,
                              background: PHASE[part.phase].color,
                            }}
                          />
                        ))}
                    </div>
                  </td>
                  <td
                    className="px-3 py-1.5 text-right font-mono whitespace-nowrap tabular-nums"
                    title={
                      used
                        ? `input ${used.tokens.input.toLocaleString('en-US')} · output ${used.tokens.output.toLocaleString('en-US')} · cache read ${used.tokens.cache_read.toLocaleString('en-US')} · cache write ${used.tokens.cache_write.toLocaleString('en-US')}`
                        : 'No token counts kept for this subagent'
                    }
                  >
                    {used ? `${tokens(sum(used.tokens))} tok · ${money(used.cost_usd)}` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {lanes.length > TABLE_SHOWN && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-xs text-accent-700"
        >
          {all ? `Show the first ${TABLE_SHOWN}` : `Show all ${lanes.length}`}
        </button>
      )}
    </section>
  );
}
