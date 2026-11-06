import { type AgentRun, RunHealth } from '@ops-console/shared';
import { useState } from 'react';
import { PageColumn } from '../app/page';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import {
  useAgentRuns,
  useAgentUsage,
  useBulkRunControls,
  useRepos,
  useRetryRuns,
  useStopSession,
} from '../lib/queries';
import { useAddress } from '../lib/remember';
import { AlertsPill } from './alerts-pill';
import { RunCard } from './run-card';
import { HealthIcon, Pill } from './run-controls';
import { canPlay, HEALTH, money, PlayIcon, tokens } from './run-look';

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
    <Pill disabled={stop.isPending} onClick={() => stop.mutate()}>
      Stop it
    </Pill>
  );
}

function AttentionIcon({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <span className={`flex size-9 flex-none items-center justify-center rounded-lg bg-card shadow-sm ${tone}`}>
      {children}
    </span>
  );
}

/** What to look at first: the slow runs and the failed ones, each with the button that deals with it. */
function Attention({ runs, open }: { runs: AgentRun[]; open: (id: string) => void }) {
  const retry = useRetryRuns();
  const slow = runs.filter((run) => run.health === RunHealth.Slow);
  const failed = runs.filter((run) => run.health === RunHealth.Failed);
  if (slow.length === 0 && failed.length === 0) return null;
  const first = slow[0];
  const retryable = failed.filter((run) => run.can_retry);
  const answers = retry.data ?? [];
  const refused = answers.filter((one) => one.status === 'rejected');
  return (
    <div className="mt-5 grid grid-cols-2 gap-3.5 max-[900px]:grid-cols-1">
      {first && (
        <div className={`flex gap-3 rounded-xl border p-4 ${HEALTH[RunHealth.Slow].card}`}>
          <AttentionIcon tone="text-warn">
            <HealthIcon health={RunHealth.Slow} running={false} />
          </AttentionIcon>
          <div className="min-w-0 flex-1">
            <h3 className="m-0 text-[13.5px]">
              {slow.length} {slow.length === 1 ? 'run is' : 'runs are'} slower than usual
            </h3>
            <p className="m-0 mt-1 mb-3 text-xs text-neutral-800">{first.health_reason.replace(/^Slow: /, '')}</p>
            <div className="flex gap-2">
              <Pill dark onClick={() => open(first.session.id)}>
                Open run
              </Pill>
              <StopOne id={first.session.id} />
            </div>
          </div>
        </div>
      )}
      {failed[0] && (
        <div className={`flex gap-3 rounded-xl border p-4 ${HEALTH[RunHealth.Failed].card}`}>
          <AttentionIcon tone="text-accent-700">
            <HealthIcon health={RunHealth.Failed} running={false} />
          </AttentionIcon>
          <div className="min-w-0 flex-1">
            <h3 className="m-0 text-[13.5px]">
              {failed.length} {failed.length === 1 ? 'run' : 'runs'} ended with an error
            </h3>
            <p className="m-0 mt-1 mb-3 text-xs text-neutral-800">
              {failed.slice(0, 2).map((run, index) => (
                <span key={run.session.id}>
                  {index > 0 && ' · '}
                  <b>{run.session.kind === 'pr_review' ? `#${run.session.pr_number}` : run.session.title}</b>:{' '}
                  {run.health_reason.replace(/^Failed: /, '')}
                </span>
              ))}
            </p>
            <div className="flex gap-2">
              <Pill dark onClick={() => open(failed[0]?.session.id ?? '')}>
                See why
              </Pill>
              <Pill
                title="Run every failed run again that can"
                disabled={retry.isPending || retryable.length === 0}
                onClick={() => retry.mutate(retryable.map((run) => run.session.id))}
              >
                {retry.isPending
                  ? 'Retrying…'
                  : failed.length === 2
                    ? 'Retry both'
                    : failed.length > 1
                      ? 'Retry all'
                      : 'Retry'}
              </Pill>
            </div>
            {retry.isSuccess && (
              <p role="status" className="m-0 mt-2 text-[11px] text-neutral-800">
                {answers.length - refused.length} of {answers.length} started again.
                {refused[0] && refused[0].status === 'rejected' && ` ${(refused[0].reason as Error).message}`}
              </p>
            )}
            {retryable.length < failed.length && (
              <p className="m-0 mt-2 text-[11px] text-neutral-700">
                {failed.length - retryable.length} cannot run again from here: open it to see why.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The page's own buttons: the alerts, stop everything going, dismiss everything that ended. */
export function AgentRunsActions() {
  const runs = useAgentRuns().data ?? [];
  const bulk = useBulkRunControls();
  const retry = useRetryRuns();
  const [asking, setAsking] = useState(false);
  const going = runs.filter((run) => run.running).length;
  const ended = runs.length - going;
  const playable = runs.filter(canPlay);
  return (
    <>
      <AlertsPill />
      <Pill
        disabled={playable.length === 0 || retry.isPending}
        title={
          playable.length === 0
            ? 'No run is paused or stopped.'
            : `Carries on every paused or stopped run (${playable.length}) from its conversation.`
        }
        onClick={() => retry.mutate(playable.map((run) => run.session.id))}
      >
        <PlayIcon />
        Play all{playable.length > 0 ? ` ${playable.length}` : ''}
      </Pill>
      <Pill
        danger
        disabled={going === 0 || bulk.stopAll.isPending}
        title="Stops every run going, in every Session. Asks first."
        onClick={() => setAsking(true)}
      >
        <span aria-hidden className="size-2 rounded-[2px] bg-current" />
        Stop all
      </Pill>
      <Pill
        disabled={ended === 0 || bulk.dismissEnded.isPending}
        title="Takes every ended run off this page. Runs going stay."
        onClick={() => bulk.dismissEnded.mutate()}
      >
        Dismiss ended
      </Pill>
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

  if (runsQuery.isPending) return <PageColumn xwide>Reading the runs…</PageColumn>;
  if (runsQuery.isError) {
    return (
      <PageColumn xwide>
        <p role="alert" className="text-accent-700">
          {runsQuery.error.message}
        </p>
      </PageColumn>
    );
  }
  return (
    <PageColumn xwide>
      <section aria-label="Overview" className="rounded-2xl border border-line bg-card p-6 shadow-sm">
        {usage && (
          <p className="m-0 mb-4 text-xs text-neutral-700">
            {runs.length} {runs.length === 1 ? 'run' : 'runs'} · {tokens(usage.tokens)} tokens · about{' '}
            {money(usage.cost_usd)} today (an estimate: a subscription is not billed by the token) · live
          </p>
        )}
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
    </PageColumn>
  );
}
