import type { AgentRun, RunDetail } from '@ops-console/shared';
import { useState } from 'react';
import { useAgentAccounts, useRunDetail, useRunQueue } from '../lib/queries';
import { alertPath, pullRequestPath, sessionPath } from '../workspace/links';
import { Split, SubagentTable } from './run-breakdown';
import { Pill, PillLink } from './run-controls';
import { SlowBox } from './run-diagnostics';
import { FailureBox } from './run-ended';
import { ACCESS_NAME, clock, KIND_NAME, MODEL_NAME, usageText, usageTip } from './run-look';
import { useRunClock } from './run-model';
import { Stepper } from './run-phases';
import { Steps } from './run-steps';
import { Timeline } from './run-timeline';

function QueueBox({ run }: { run: AgentRun }) {
  const queue = useRunQueue(run.session.id);
  const text = run.session.queued_message;
  if (text === null) return null;
  return (
    <section className="mb-4 flex items-center gap-2.5 rounded-xl border border-info/30 bg-info/[0.07] px-3 py-2 text-xs">
      <span className="flex-none rounded-full bg-info/14 px-2 py-px font-mono text-[11px] text-info">
        {run.running ? '1 queued' : 'on hold'}
      </span>
      <span className="min-w-0 flex-1 truncate" title={text}>
        “{text}”
      </span>
      <Pill className="py-0.5" disabled={queue.sendNow.isPending} onClick={() => queue.sendNow.mutate()}>
        Send now
      </Pill>
      <Pill className="py-0.5" disabled={queue.takeBack.isPending} onClick={() => queue.takeBack.mutate()}>
        Take back
      </Pill>
    </section>
  );
}

/** The analytics of one run: where it is, why it is slow or ended, where its time went, every call. */
export function RunAnalytics({ run, detail }: { run: AgentRun; detail: RunDetail }) {
  const live = detail.run;
  const clockOfRun = useRunClock(live, detail.steps);
  const [agent, setAgent] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ id: string; n: number } | null>(null);
  const jump = (id: string) => {
    setAgent(null);
    setReveal((now) => ({ id, n: (now?.n ?? 0) + 1 }));
  };
  return (
    <>
      {detail.stages.length > 0 && <Stepper stages={detail.stages} />}
      <SlowBox detail={detail} run={run} />
      {detail.failure && <FailureBox failure={detail.failure} run={run} />}
      {clockOfRun && (
        <>
          <Split run={live} clock={clockOfRun} />
          <SubagentTable run={live} clock={clockOfRun} filter={agent} onFilter={setAgent} />
          {(detail.steps.length > 0 || live.subagents.length > 0) && (
            <Timeline run={live} clock={clockOfRun} steps={detail.steps} onJump={jump} />
          )}
        </>
      )}
      <Steps run={live} clock={clockOfRun} steps={detail.steps} agent={agent} onAgent={setAgent} reveal={reveal} />
      {detail.steps.length === 0 && (
        <p className="m-0 text-xs text-neutral-700">
          The console kept no steps for this run: it started before steps were kept.
        </p>
      )}
    </>
  );
}

/** Everything about one run that does not fit its card: where it runs, why, where the time went, every call. */
export function RunDetailPanel({ run, repoName }: { run: AgentRun; repoName: (id: string | null) => string }) {
  const detail = useRunDetail(run.session.id);
  const accounts = useAgentAccounts().data?.data ?? [];
  const { session } = run;
  const account = accounts.find((one) => one.id === session.account_id);
  const usage = usageText(run);
  const info: [string, string, string?][] = [
    ['Kind', KIND_NAME[session.kind]],
    ['Access', ACCESS_NAME[session.access_mode]],
    ...(account ? ([['Account', account.email ?? account.label]] as [string, string][]) : []),
    ['Started', run.started_at ? clock(run.started_at) : '—'],
    ['Model', MODEL_NAME[session.model]],
    ...(session.repo_id ? ([['Repo', repoName(session.repo_id)]] as [string, string][]) : []),
    ...(!run.running && run.finished_at ? ([['Ended', clock(run.finished_at)]] as [string, string][]) : []),
    ...(usage ? ([['Usage', usage, usageTip(run)]] as [string, string, string][]) : []),
  ];
  return (
    <div className="border-t border-line px-5 py-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <PillLink to={sessionPath(session.id)}>Open Session ↗</PillLink>
        {session.repo_id !== null && session.pr_number !== null && (
          <PillLink to={pullRequestPath(session.repo_id, session.pr_number)}>
            Pull request #{session.pr_number} ↗
          </PillLink>
        )}
        {session.alert_id && <PillLink to={alertPath(session.alert_id)}>Monitor Alert ↗</PillLink>}
      </div>
      <dl
        data-testid="run-facts"
        className="m-0 mb-4 grid grid-cols-3 gap-x-8 gap-y-1.5 text-xs max-[1100px]:grid-cols-2 max-[640px]:grid-cols-1"
      >
        {info.map(([name, value, tip]) => (
          <div key={name} className="flex min-w-0 gap-2">
            <dt className="w-14 flex-none text-neutral-700">{name}</dt>
            <dd title={tip ?? value} className="m-0 min-w-0 font-mono text-text break-words max-[900px]:truncate">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <QueueBox run={run} />
      {detail.isPending && <p className="m-0 text-xs text-neutral-700">Reading the run…</p>}
      {detail.isError && (
        <p role="alert" className="m-0 text-xs text-accent-700">
          {detail.error.message}
        </p>
      )}
      {detail.data && <RunAnalytics run={run} detail={detail.data} />}
    </div>
  );
}
