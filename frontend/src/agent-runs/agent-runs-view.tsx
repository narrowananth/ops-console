import { type AgentRun, RunHealth } from '@ops-console/shared';
import { useState } from 'react';
import { PageColumn } from '../app/page';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Toggle } from '../components/ui/toggle';
import {
  useAgentRuns,
  useAgentUsage,
  useBulkRunControls,
  useRepos,
  useRetryRuns,
  useStopSession,
} from '../lib/queries';
import { useAddress, useStored } from '../lib/remember';
import { ALERT_ENDS_KEY, ALERT_NEEDS_KEY, alertSchema, allowDesktopAlerts } from './alerts';
import { RunCard } from './run-card';
import { HEALTH, money, tokens } from './run-look';

type Tab = 'all' | 'on_track' | 'slow' | 'needs_you' | 'ended';

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'on_track', label: 'On track' },
  { id: 'slow', label: 'Slow' },
  { id: 'needs_you', label: 'Needs you' },
  { id: 'ended', label: 'Ended' },
];

/** The order that puts a run to look at first. */
const ATTENTION: Record<RunHealth, number> = {
  [RunHealth.NeedsYou]: 0,
  [RunHealth.Slow]: 1,
  [RunHealth.Failed]: 2,
  [RunHealth.OnTrack]: 3,
  [RunHealth.Stopped]: 4,
};

const inTab = (run: AgentRun, tab: Tab) =>
  tab === 'all' ||
  (tab === 'ended' ? !run.running : tab === 'on_track' ? run.health === RunHealth.OnTrack : run.health === tab);

/** The ring: how many runs are in each health, with the total in the middle. */
function Donut({ counts, total }: { counts: [RunHealth, number][]; total: number }) {
  const radius = 14.5;
  const circle = 2 * Math.PI * radius;
  const colors: Record<RunHealth, string> = {
    [RunHealth.OnTrack]: 'var(--color-ok)',
    [RunHealth.Slow]: 'var(--color-warn)',
    [RunHealth.NeedsYou]: 'var(--color-info)',
    [RunHealth.Failed]: 'var(--color-accent)',
    [RunHealth.Stopped]: 'var(--color-neutral-400)',
  };
  let offset = 0;
  return (
    <div className="relative size-30 flex-none" role="img" aria-label={`${total} runs`}>
      <svg viewBox="0 0 36 36" className="size-full -rotate-90" aria-hidden>
        <circle cx="18" cy="18" r={radius} fill="none" stroke="var(--color-neutral-200)" strokeWidth="4" />
        {counts
          .filter(([, count]) => count > 0)
          .map(([health, count]) => {
            const length = (count / total) * circle;
            const arc = (
              <circle
                key={health}
                cx="18"
                cy="18"
                r={radius}
                fill="none"
                stroke={colors[health]}
                strokeWidth="4"
                strokeLinecap="round"
                strokeDasharray={`${Math.max(0, length - 1.5)} ${circle}`}
                strokeDashoffset={-offset}
              />
            );
            offset += length;
            return arc;
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <b className="text-[26px] leading-none">{total}</b>
        <span className="text-[10px] text-neutral-700">{total === 1 ? 'run' : 'runs'}</span>
      </div>
    </div>
  );
}

function StopOne({ id }: { id: string }) {
  const stop = useStopSession(id);
  return (
    <Button className="px-3 py-1 text-xs" disabled={stop.isPending} onClick={() => stop.mutate()}>
      Stop it
    </Button>
  );
}

/** What to look at first: the slow runs and the failed ones, each with the button that deals with it. */
function Attention({ runs, open }: { runs: AgentRun[]; open: (id: string) => void }) {
  const retry = useRetryRuns();
  const slow = runs.filter((run) => run.health === RunHealth.Slow);
  const failed = runs.filter((run) => run.health === RunHealth.Failed);
  if (slow.length === 0 && failed.length === 0) return null;
  const first = slow[0];
  return (
    <div className="mt-4 grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
      {first && (
        <div className={`rounded-xl border p-3.5 ${HEALTH[RunHealth.Slow].card}`}>
          <h3 className="m-0 text-[13px] text-warn">
            {slow.length} {slow.length === 1 ? 'run is' : 'runs are'} slower than usual
          </h3>
          <p className="m-0 mt-1 mb-2.5 text-xs text-neutral-800">{first.health_reason.replace(/^Slow: /, '')}</p>
          <div className="flex gap-1.5">
            <Button variant="primary" className="px-3 py-1 text-xs" onClick={() => open(first.session.id)}>
              Open run
            </Button>
            <StopOne id={first.session.id} />
          </div>
        </div>
      )}
      {failed[0] && (
        <div className={`rounded-xl border p-3.5 ${HEALTH[RunHealth.Failed].card}`}>
          <h3 className="m-0 text-[13px] text-accent-700">
            {failed.length} {failed.length === 1 ? 'run' : 'runs'} ended with an error
          </h3>
          <p className="m-0 mt-1 mb-2.5 text-xs text-neutral-800">
            {failed
              .slice(0, 2)
              .map((run) => `${run.session.title}: ${run.health_reason.replace(/^Failed: /, '')}`)
              .join(' · ')}
          </p>
          <div className="flex gap-1.5">
            <Button variant="primary" className="px-3 py-1 text-xs" onClick={() => open(failed[0]?.session.id ?? '')}>
              See why
            </Button>
            <Button
              className="px-3 py-1 text-xs"
              title="Retry every failed run that takes messages"
              disabled={retry.isPending}
              onClick={() => retry.mutate(failed.filter((run) => run.can_resume).map((run) => run.session.id))}
            >
              Retry {failed.length > 1 ? 'all' : ''}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Desktop alerts: the browser asks once; they show only while the console is open in a tab behind another. */
function AlertSettings() {
  const [needs, setNeeds] = useStored(ALERT_NEEDS_KEY, alertSchema, false);
  const [ends, setEnds] = useStored(ALERT_ENDS_KEY, alertSchema, false);
  const [refused, setRefused] = useState(false);
  const change = (set: (value: boolean) => void) => async (value: boolean) => {
    if (value && !(await allowDesktopAlerts())) {
      setRefused(true);
      return;
    }
    setRefused(false);
    set(value);
  };
  return (
    <section aria-label="Alerts" className="mt-6 rounded-xl border border-line bg-card p-4 shadow-sm">
      <h2 className="m-0 mb-0.5 text-[15px]">Alerts</h2>
      <p className="m-0 mb-3 text-xs text-neutral-700">
        A desktop alert shows while this console is open in a tab you are not looking at.
      </p>
      <div className="flex flex-col gap-2.5 text-[13px]">
        <div className="flex items-center gap-3">
          <Toggle checked={needs} label="Alert when a run needs me" onChange={change(setNeeds)} />
          Alert when a run needs me
        </div>
        <div className="flex items-center gap-3">
          <Toggle checked={ends} label="Alert when a run ends" onChange={change(setEnds)} />
          Alert when a run ends
        </div>
      </div>
      {refused && (
        <p role="alert" className="m-0 mt-2 text-xs text-accent-700">
          The browser did not allow alerts. Allow notifications for this site in the browser, then turn this on again.
        </p>
      )}
    </section>
  );
}

/** The page's own buttons: stop everything going, dismiss everything that ended. */
export function AgentRunsActions() {
  const runs = useAgentRuns().data ?? [];
  const bulk = useBulkRunControls();
  const [asking, setAsking] = useState(false);
  const going = runs.filter((run) => run.running).length;
  const ended = runs.length - going;
  return (
    <>
      <Button
        className="px-3 py-1.5 text-xs"
        disabled={going === 0 || bulk.stopAll.isPending}
        title="Stops every run going, in every Session. Asks first."
        onClick={() => setAsking(true)}
      >
        Stop all
      </Button>
      <Button
        className="px-3 py-1.5 text-xs"
        disabled={ended === 0 || bulk.dismissEnded.isPending}
        title="Takes every ended run off this page. Runs going stay."
        onClick={() => bulk.dismissEnded.mutate()}
      >
        Dismiss ended
      </Button>
      {asking && (
        <ConfirmDialog
          title={`Stop ${going} ${going === 1 ? 'run' : 'runs'}?`}
          action="Stop all"
          pending={bulk.stopAll.isPending}
          error={bulk.stopAll.error?.message}
          onConfirm={() => bulk.stopAll.mutate(undefined, { onSuccess: () => setAsking(false) })}
          onCancel={() => setAsking(false)}
        >
          Every agent run going stops where it is. Each stays on this page, and Play carries it on.
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * The Agent runs page: every run in the console, whether to look at it and why, what it does and where its time goes,
 * why it is slow or ended, and the controls to pause, stop, play, retry or dismiss it.
 */
export function AgentRunsView() {
  const runsQuery = useAgentRuns();
  const usage = useAgentUsage().data;
  const repos = useRepos().data?.data ?? [];
  const [tab, setTab] = useState<Tab>('all');
  const [{ run: openId }, setAddress] = useAddress('run');
  const runs = [...(runsQuery.data ?? [])].sort(
    (a, b) => ATTENTION[a.health] - ATTENTION[b.health] || (b.started_at ?? '').localeCompare(a.started_at ?? ''),
  );
  const repoName = (id: string | null) => repos.find((repo) => repo.id === id)?.name ?? 'Repo';
  const count = (health: RunHealth) => runs.filter((run) => run.health === health).length;
  const counts: [RunHealth, number][] = [
    [RunHealth.OnTrack, count(RunHealth.OnTrack)],
    [RunHealth.Slow, count(RunHealth.Slow)],
    [RunHealth.NeedsYou, count(RunHealth.NeedsYou)],
    [RunHealth.Failed, count(RunHealth.Failed)],
    [RunHealth.Stopped, count(RunHealth.Stopped)],
  ];
  const shown = runs.filter((run) => inTab(run, tab));
  const tabCount = (id: Tab) => runs.filter((run) => inTab(run, id)).length;
  const open = (id: string) => {
    setTab('all');
    setAddress({ run: id });
  };

  if (runsQuery.isPending) return <PageColumn wide>Reading the runs…</PageColumn>;
  if (runsQuery.isError) {
    return (
      <PageColumn wide>
        <p role="alert" className="text-accent-700">
          {runsQuery.error.message}
        </p>
      </PageColumn>
    );
  }
  return (
    <PageColumn wide>
      <section aria-label="Overview" className="rounded-xl border border-line bg-card p-5 shadow-sm">
        <div className="flex items-center gap-6">
          <Donut counts={counts} total={runs.length} />
          <div className="grid flex-1 grid-cols-4 gap-2.5 max-[900px]:grid-cols-2">
            {counts
              .filter(([health]) => health !== RunHealth.Stopped)
              .map(([health, n]) => (
                <div
                  key={health}
                  className={`rounded-xl px-3.5 py-3 ${HEALTH[health].icon}`}
                  title={HEALTH[health].tip}
                >
                  <b className="block text-2xl leading-tight">{n}</b>
                  <span className="flex items-center gap-1.5 text-[11px]">
                    <i
                      className={`size-1.75 rounded-full ${HEALTH[health].dot} ${health === RunHealth.OnTrack && n > 0 ? 'animate-pulse' : ''}`}
                    />
                    {HEALTH[health].label === 'failed'
                      ? 'Failed'
                      : HEALTH[health].label.replace(/^./, (c) => c.toUpperCase())}
                  </span>
                </div>
              ))}
          </div>
        </div>
        {usage && (
          <p className="m-0 mt-3 text-xs text-neutral-700">
            Today: {usage.runs} {usage.runs === 1 ? 'run' : 'runs'} ended · {tokens(usage.tokens)} tokens · about{' '}
            {money(usage.cost_usd)} (an estimate: a subscription is not billed by the token)
          </p>
        )}
        <Attention runs={runs} open={open} />
      </section>

      <div
        role="tablist"
        aria-label="Filter runs"
        className="mt-5 mb-3 flex w-max gap-1 rounded-full bg-neutral-200 p-1"
      >
        {TABS.map((one) => (
          <button
            key={one.id}
            type="button"
            role="tab"
            aria-selected={tab === one.id}
            onClick={() => setTab(one.id)}
            className={`cursor-pointer rounded-full border-0 px-3.5 py-1 text-xs ${
              tab === one.id ? 'bg-card font-semibold text-text shadow-sm' : 'bg-transparent text-neutral-700'
            }`}
          >
            {one.label}
            <i className="ml-1.5 font-mono text-[10px] not-italic opacity-70">{tabCount(one.id)}</i>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="rounded-xl border border-line bg-card px-4 py-6 text-center text-[13px] text-neutral-700 shadow-sm">
          {runs.length === 0
            ? 'No agent runs. Runs show here while the agent works, and a run that stopped or failed stays until you dismiss it.'
            : 'No runs in this tab.'}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {shown.map((run) => (
            <RunCard
              key={run.session.id}
              run={run}
              repoName={repoName}
              open={openId === run.session.id}
              onToggle={() => setAddress({ run: openId === run.session.id ? null : run.session.id })}
            />
          ))}
        </ul>
      )}
      <AlertSettings />
    </PageColumn>
  );
}
