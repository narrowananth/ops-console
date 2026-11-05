import { type AgentRun, RunHealth, RunOutcome, type Subagent, SubagentStatus } from '@ops-console/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Elapsed } from '../components/ui/elapsed';
import {
  useAgentAccounts,
  useAgentRuns,
  useAgentUsage,
  useBulkRunControls,
  useRepos,
  useRunQueue,
} from '../lib/queries';
import { alertPath, pullRequestPath } from '../workspace/links';
import { AlertsPill } from './alerts-pill';
import { Pill, RunButtons } from './run-controls';
import { ACCESS_NAME, clock, HEALTH, KIND_NAME, MODEL_NAME, money, placeOf, titleOf, tokens } from './run-look';

type Tab = 'all' | 'going' | 'needs_you' | 'ended';

/** How many going runs the tray lists before "Show all". */
const GOING_SHOWN = 3;

/** How an ended run reads. It stays in the tray until dismissed. */
const OUTCOME_LABEL: Record<RunOutcome, string> = {
  [RunOutcome.Done]: 'done',
  [RunOutcome.Stopped]: 'stopped',
  [RunOutcome.Paused]: 'paused',
  [RunOutcome.Failed]: 'failed',
  [RunOutcome.RateLimited]: 'limit reached',
  [RunOutcome.SignedOut]: 'signed out',
  [RunOutcome.Interrupted]: 'interrupted',
};

const SUBAGENT_TONE: Record<SubagentStatus, string> = {
  [SubagentStatus.Working]: 'bg-neutral-200 text-neutral-700',
  [SubagentStatus.Done]: 'bg-neutral-200 text-neutral-700',
  [SubagentStatus.Failed]: 'bg-accent-100 text-accent-700',
  [SubagentStatus.Stopped]: 'bg-accent-100 text-accent-700',
};

const needsYou = (run: AgentRun) => run.running && run.health === RunHealth.NeedsYou;

/** The agent's open step, with its subject set in code: `Running` and `pnpm test backend`. */
function Activity({ text }: { text: string }) {
  const space = text.indexOf(' ');
  if (space < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, space)}{' '}
      <code className="rounded bg-neutral-200 px-1 font-mono text-[10.5px]">{text.slice(space + 1)}</code>
    </>
  );
}

/** The subagents under `parent`, each with its own, in the order they started. */
function SubagentTree({
  all,
  parent,
  to,
  depth = 0,
}: {
  all: Subagent[];
  parent: string | null;
  to: string;
  depth?: number;
}) {
  const known = new Set(all.map((one) => one.id));
  // One whose parent is not listed hangs on the main agent.
  const children = all.filter(
    (one) => (one.parent_id !== null && known.has(one.parent_id) ? one.parent_id : null) === parent,
  );
  if (children.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {children.map((one) => {
        const working = one.status === SubagentStatus.Working;
        return (
          <li key={one.id} className={depth > 0 ? 'ml-4 border-l-2 border-line pl-3' : ''}>
            <div className="flex items-center gap-2 py-1.5">
              <div className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{one.description}</span>
                {one.type && <span className="block truncate text-[11px] text-neutral-700">{one.type}</span>}
              </div>
              <span className="flex flex-none flex-col items-end gap-0.5">
                <span className={`rounded-full px-2 py-px font-mono text-[10.5px] ${SUBAGENT_TONE[one.status]}`}>
                  {one.status === SubagentStatus.Done ? 'done' : one.status}
                </span>
                <Elapsed from={one.started_at} to={one.finished_at} running={working} took={!working} />
              </span>
              <Link
                to={to}
                title="Open the Session this subagent works in"
                aria-label={`Open the Session of ${one.description}`}
                className="flex size-6.5 flex-none items-center justify-center rounded-lg border border-divider bg-card text-xs text-text no-underline shadow-sm hover:bg-neutral-200"
              >
                ↗
              </Link>
            </div>
            <SubagentTree all={all} parent={one.id} to={to} depth={depth + 1} />
          </li>
        );
      })}
    </ul>
  );
}

const CHIP =
  'inline-flex items-center gap-1 rounded-full border border-info/30 bg-card px-2.5 py-0.5 text-[11.5px] text-info no-underline hover:bg-info/10';

/** What a run shows once opened: why it ended, its facts, its links, its queued message and its subagents. */
function RunBody({ run, to, where }: { run: AgentRun; to: string; where: string }) {
  const { session } = run;
  const queue = useRunQueue(session.id);
  const accounts = useAgentAccounts().data?.data ?? [];
  const account = accounts.find((one) => one.id === session.account_id);
  const working = run.subagents.filter((one) => one.status === SubagentStatus.Working).length;
  const ended = !run.running && run.outcome !== null && run.outcome !== RunOutcome.Done;
  const facts: [string, string][] = [
    ['Kind', KIND_NAME[session.kind]],
    [run.running ? 'Started' : 'Ended', clock((run.running ? run.started_at : run.finished_at) ?? session.created_at)],
    ['Access', ACCESS_NAME[session.access_mode]],
    ['Model', MODEL_NAME[session.model]],
    ...(account ? ([['Account', account.email ?? account.label]] as [string, string][]) : []),
    ...(run.cost_usd !== null
      ? ([['Usage', `${run.tokens ? `${tokens(run.tokens)} tok · ` : ''}${money(run.cost_usd)}`]] as [string, string][])
      : []),
  ];
  return (
    <div className="mx-2.5 mb-3 flex flex-col gap-2.5">
      {ended && run.outcome !== RunOutcome.Stopped && run.outcome !== RunOutcome.Paused && (
        <div className="rounded-lg border border-accent-300 bg-accent-100 px-3 py-2 text-xs text-accent-800">
          <b className="block text-accent-700">Why it ended</b>
          {run.health_reason.replace(/^(Failed|Stopped): /, '')}
        </div>
      )}
      <div className="rounded-xl border border-line bg-card px-3 py-2.5">
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          {facts.map(([name, value]) => (
            <div key={name} className="flex gap-3">
              <dt className="w-14 flex-none text-neutral-700">{name}</dt>
              <dd className="m-0 min-w-0 truncate font-mono">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Link to={to} className={CHIP}>
            ↗ {session.kind === 'pr_review' ? 'Open pull request' : 'Open Session'}
          </Link>
          {session.repo_id !== null && session.pr_number !== null && session.kind !== 'pr_review' && (
            <Link to={pullRequestPath(session.repo_id, session.pr_number)} className={CHIP}>
              ↗ PR #{session.pr_number}
            </Link>
          )}
          {session.alert_id && (
            <Link to={alertPath(session.alert_id)} className={CHIP}>
              ↗ Monitor Alert
            </Link>
          )}
          <span className="inline-flex items-center rounded-full border border-divider bg-neutral-100 px-2.5 py-0.5 text-[11.5px] text-neutral-800">
            {where}
            {session.branch ? ` · ${session.branch}` : ''}
          </span>
        </div>
        {session.queued_message !== null && (
          <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-info/25 bg-info/[0.07] px-2.5 py-1.5 text-xs">
            <span className="flex-none rounded-full bg-info/14 px-2 py-px font-mono text-[10.5px] text-info">
              {run.running ? '1 queued' : 'on hold'}
            </span>
            <span className="min-w-0 flex-1 truncate" title={session.queued_message}>
              “{session.queued_message}”
            </span>
            <Pill className="py-0.5" disabled={queue.sendNow.isPending} onClick={() => queue.sendNow.mutate()}>
              Send now
            </Pill>
            <Pill className="py-0.5" disabled={queue.takeBack.isPending} onClick={() => queue.takeBack.mutate()}>
              Take back
            </Pill>
          </div>
        )}
      </div>
      {run.subagents.length > 0 && (
        <div className="ml-2 border-l-2 border-line pl-3">
          <p className="m-0 mb-0.5 text-[11.5px] text-neutral-700">
            {run.subagents.length} {run.subagents.length === 1 ? 'subagent' : 'subagents'}
            {working > 0 ? ` (${working} working)` : ''}
          </p>
          <SubagentTree all={run.subagents} parent={null} to={to} />
        </div>
      )}
    </div>
  );
}

/** One run: its title, what it does or why it stopped, its state and time, its controls, and a fold with the rest. */
function RunRow({
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
  const place = placeOf(session, repoName);
  const look = HEALTH[run.health];
  const chip = run.running
    ? { text: run.health === RunHealth.OnTrack ? 'working' : look.label, tone: look.chip }
    : { text: run.outcome ? OUTCOME_LABEL[run.outcome] : 'ended', tone: look.chip };
  const stoppedBy =
    run.outcome === RunOutcome.Stopped
      ? 'stopped by you'
      : run.outcome === RunOutcome.Paused
        ? 'paused by you'
        : 'ended';
  const sub = run.running ? (
    needsYou(run) ? (
      run.health_reason
    ) : run.activity ? (
      <Activity text={run.activity} />
    ) : (
      place.where
    )
  ) : (
    `${place.where} · ${stoppedBy}${run.finished_at ? ` · ${clock(run.finished_at)}` : ''}`
  );
  return (
    <li className={open ? 'bg-neutral-100/70' : ''}>
      <div className="flex items-start gap-2 px-3.5 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} details of ${place.what}`}
          title="Facts, links, queued message and subagents"
          onClick={onToggle}
          className="mt-0.5 flex size-4.5 flex-none cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-neutral-700 hover:text-text"
        >
          <span aria-hidden className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>
            ›
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <Link
            to={place.to}
            title={place.tip}
            className="block truncate text-[13.5px] font-semibold text-text no-underline hover:underline"
          >
            {titleOf(session, place.what)}
          </Link>
          <span className="block truncate text-[11.5px] text-neutral-700">{sub}</span>
        </div>
        <span className="flex flex-none flex-col items-end gap-0.5">
          <span title={look.tip} className={`rounded-full px-2 py-px font-mono text-[10.5px] ${chip.tone}`}>
            {chip.text}
          </span>
          <Elapsed from={run.started_at} to={run.finished_at} running={run.running} took={!run.running} />
        </span>
        <RunButtons run={run} square />
      </div>
      {open && <RunBody run={run} to={place.to} where={place.where} />}
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="m-0 px-4 pt-3 pb-1 font-mono text-[10.5px] font-normal tracking-wider text-neutral-700 uppercase">
        {title}
      </h3>
      <ul className="m-0 flex list-none flex-col p-0">{children}</ul>
    </section>
  );
}

/**
 * The tray: every agent run in any Session, with filters. Runs that need the operator come first, then the ones going,
 * then the ones that ended, which stay until dismissed. A run opens in place to its facts and subagents, and can be
 * paused, stopped, played or retried from here.
 */
export function RunTray() {
  const runs = useAgentRuns().data ?? [];
  const usage = useAgentUsage().data;
  const repos = useRepos().data?.data ?? [];
  const bulk = useBulkRunControls();
  const [tab, setTab] = useState<Tab>('all');
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const repoName = (id: string | null) => repos.find((repo) => repo.id === id)?.name ?? 'Repo';
  const going = runs.filter((run) => run.running);
  const waiting = runs.filter(needsYou);
  const ended = runs.filter((run) => !run.running);
  const only = going.filter((run) => !needsYou(run));
  const tabs: [Tab, string, number][] = [
    ['all', 'All', runs.length],
    ['going', 'Going', going.length],
    ['needs_you', 'Needs you', waiting.length],
    ['ended', 'Ended', ended.length],
  ];
  const toggle = (id: string) =>
    setOpenIds((now) => (now.includes(id) ? now.filter((one) => one !== id) : [...now, id]));
  const row = (run: AgentRun) => (
    <RunRow
      key={run.session.id}
      run={run}
      repoName={repoName}
      open={openIds.includes(run.session.id)}
      onToggle={() => toggle(run.session.id)}
    />
  );
  const cut = tab === 'all' && !showAll && only.length > GOING_SHOWN;
  const shownGoing = cut ? only.slice(0, GOING_SHOWN) : only;
  return (
    <>
      <header className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-divider px-4 py-3">
        <b className="text-[14px]">
          {runs.length} agent {runs.length === 1 ? 'run' : 'runs'}
        </b>
        <span className="font-mono text-[11px] text-neutral-700">
          {going.length} going · {waiting.length} {waiting.length === 1 ? 'needs' : 'need'} you · {ended.length} ended
        </span>
        <span className="flex-1" />
        <AlertsPill />
        {confirming ? (
          <span className="flex items-center gap-1.5 text-xs">
            Stop {going.length}?
            <Pill
              dark
              disabled={bulk.stopAll.isPending}
              onClick={() => bulk.stopAll.mutate(undefined, { onSuccess: () => setConfirming(false) })}
            >
              Yes, stop
            </Pill>
            <Pill onClick={() => setConfirming(false)}>No</Pill>
          </span>
        ) : (
          <Pill
            disabled={going.length === 0}
            title="Stops every run going, in every Session. Each stays here, and Play carries it on."
            onClick={() => setConfirming(true)}
          >
            Stop all going
          </Pill>
        )}
      </header>
      <div
        role="tablist"
        aria-label="Filter runs"
        className="flex flex-none items-center gap-1.5 border-b border-divider px-4 py-2"
      >
        {tabs.map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`cursor-pointer rounded-full border px-3 py-0.5 text-xs ${
              tab === id
                ? 'border-text bg-text font-semibold text-card'
                : 'border-divider bg-card text-neutral-800 hover:bg-neutral-200'
            }`}
          >
            {label} <span className="font-mono text-[10.5px] opacity-70">{n}</span>
          </button>
        ))}
        <span className="flex-1" />
        {usage && (
          <span className="font-mono text-[11px] text-neutral-700">
            {tokens(usage.tokens)} tokens · {money(usage.cost_usd)} today
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {runs.length === 0 ? (
          <p className="m-0 px-4 py-4 text-xs text-neutral-700">
            Runs show here while the agent works or waits on you, in any Session. One you stop or one that runs out of
            usage stays until you dismiss it.
          </p>
        ) : (
          <>
            {(tab === 'all' || tab === 'needs_you' || tab === 'going') && waiting.length > 0 && (
              <Section title="Needs you">{waiting.map(row)}</Section>
            )}
            {(tab === 'all' || tab === 'going') && only.length > 0 && (
              <Section title="Going">
                {shownGoing.map(row)}
                {cut && (
                  <li className="flex items-center justify-between px-4 py-2 text-xs text-neutral-700">
                    … {only.length - GOING_SHOWN} more going
                    <Pill onClick={() => setShowAll(true)}>Show all</Pill>
                  </li>
                )}
              </Section>
            )}
            {(tab === 'all' || tab === 'ended') && ended.length > 0 && (
              <Section title="Ended · kept until you dismiss">{ended.map(row)}</Section>
            )}
            {tab === 'needs_you' && waiting.length === 0 && (
              <p className="m-0 px-4 py-4 text-xs text-neutral-700">No run waits on you.</p>
            )}
          </>
        )}
      </div>
      <footer className="flex flex-none items-center gap-3 border-t border-divider px-4 py-2.5">
        <span className="min-w-0 flex-1 font-mono text-[11px] text-neutral-700">
          Click a title to open that Session · ✕ keeps nothing, ended runs stay until dismissed ·{' '}
          <Link to="/agent-runs" title="Health, time, errors and the steps of every run">
            Open Agent runs →
          </Link>
        </span>
        <Pill disabled={ended.length === 0 || bulk.dismissEnded.isPending} onClick={() => bulk.dismissEnded.mutate()}>
          Dismiss all ended
        </Pill>
      </footer>
    </>
  );
}
