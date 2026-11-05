import { type AgentRun, SubagentStatus } from '@ops-console/shared';
import { Link } from 'react-router-dom';
import { Elapsed } from '../components/ui/elapsed';
import { HealthIcon, RunButtons } from './run-controls';
import { RunDetailPanel } from './run-detail';
import { ACCESS_NAME, HEALTH, MODEL_NAME, money, PHASE, placeOf, titleOf, tokens } from './run-look';

/** The time a run spent in each phase, as one strip. */
export function PhaseStrip({ run }: { run: AgentRun }) {
  const total = run.split.reduce((sum, part) => sum + part.ms, 0);
  if (total <= 0) return null;
  return (
    <div className="mt-2 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-neutral-200" aria-hidden>
      {run.split
        .filter((part) => part.ms > 0)
        .map((part) => (
          <span
            key={part.phase}
            title={`${PHASE[part.phase].label}: ${Math.round((part.ms / total) * 100)}%`}
            className="block h-full rounded-full"
            style={{ width: `${(part.ms / total) * 100}%`, background: PHASE[part.phase].color }}
          />
        ))}
    </div>
  );
}

/** One run as a card: its health, why, where its time went, its controls, and a fold with everything else. */
export function RunCard({
  run,
  repoName,
  open,
  onToggle,
}: {
  run: AgentRun;
  repoName: (id: string | null) => string;
  open: boolean;
  onToggle: () => void;
}) {
  const { session } = run;
  const look = HEALTH[run.health];
  const place = placeOf(session, repoName);
  const going = run.subagents.filter((one) => one.status === SubagentStatus.Working).length;
  const usage =
    run.cost_usd !== null ? `${money(run.cost_usd)}${run.tokens ? ` · ${tokens(run.tokens)} tokens` : ''}` : null;
  const facts = [
    place.where,
    session.branch,
    ACCESS_NAME[session.access_mode],
    MODEL_NAME[session.model],
    run.subagents.length > 0
      ? `${run.subagents.length} ${run.subagents.length === 1 ? 'subagent' : 'subagents'}${going > 0 ? ` (${going} working)` : ''}`
      : null,
    session.queued_message !== null ? '1 queued' : null,
    usage,
  ].filter(Boolean);
  return (
    <li
      className={`list-none rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md ${look.card} ${open ? 'shadow-md' : ''}`}
    >
      <div className="flex items-center gap-3.5 px-3.5 py-3.5">
        <span title={look.tip} className={`flex size-11 flex-none items-center justify-center rounded-xl ${look.icon}`}>
          <HealthIcon health={run.health} running={run.running} />
        </span>
        <div className="min-w-0 flex-1">
          <Link
            to={place.to}
            title={place.tip}
            className="block truncate text-[13.5px] font-semibold text-text no-underline hover:underline"
          >
            {titleOf(session, place.what)}
          </Link>
          <span className="block truncate text-[11.5px] text-neutral-700">{facts.join(' · ')}</span>
          <span className={`mt-1 block text-[12.5px] ${look.reason}`}>{run.health_reason}</span>
          {session.queued_message !== null && (
            <span className="mt-0.5 block truncate text-[11px] text-info">queued: “{session.queued_message}”</span>
          )}
          <PhaseStrip run={run} />
        </div>
        <div className="flex flex-none flex-col items-end gap-1.5">
          <span title={look.tip} className={`rounded-full px-2.5 py-px font-mono text-[11px] ${look.chip}`}>
            {look.label}
          </span>
          <Elapsed from={run.started_at} to={run.finished_at} running={run.running} took={!run.running} />
          <RunButtons run={run} />
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} details of ${place.what}`}
            title="Where the time went, the steps, and why it is slow or failed"
            onClick={onToggle}
            className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-neutral-700 hover:text-text"
          >
            {open ? 'Hide details ˄' : 'Details ˅'}
          </button>
        </div>
      </div>
      {open && <RunDetailPanel run={run} repoName={repoName} />}
    </li>
  );
}
