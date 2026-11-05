import { type AgentRun, type Failure, FailureKind, type RunDetail, type RunStep } from '@ops-console/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Spinner } from '../components/ui/button';
import { duration } from '../components/ui/elapsed';
import { copyLabel, useCopy } from '../lib/clipboard';
import { useAddNetworkDomain, useRunControls, useRunDetail, useRunQueue, useStopSession } from '../lib/queries';
import { alertPath, pullRequestPath, sessionPath } from '../workspace/links';
import { clock, FAILURE_LABEL, failureTone, money, PHASE, STAGE_LABEL, tokens } from './run-look';

/** What the agent is told when the operator stops a run for taking too long. */
const SKIP_TEXT =
  'That step was taking too long, so I stopped it. Do not wait on it again: skip it or mock the call, then carry on.';

const shown = (summary: string) => (summary.startsWith('$ ') ? summary.slice(2) : summary);

function Heading({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <h3 className="m-0 mb-2 flex items-baseline gap-2 text-[13px] font-semibold">
      {children}
      {note && <small className="text-[11px] font-normal text-neutral-700">{note}</small>}
    </h3>
  );
}

/** The run's usual order of work, with where it is now. Read from the tools it used, so it can be wrong. */
function Stepper({ stages }: { stages: RunDetail['stages'] }) {
  return (
    <ol
      className="m-0 mb-4 flex list-none p-0"
      title="Read from the tools the run used, so a run that works another way can show a stage it skipped as done."
    >
      {stages.map((one, index) => (
        <li
          key={one.stage}
          aria-current={one.state === 'now' ? 'step' : undefined}
          className={`relative flex flex-1 flex-col items-center gap-1 text-center text-[10.5px] ${one.state === 'todo' ? 'text-neutral-700' : 'text-text'} ${one.state === 'now' ? 'font-semibold' : ''}`}
        >
          {index > 0 && (
            <span
              aria-hidden
              className={`absolute top-2.5 right-1/2 h-0.5 w-full ${one.state === 'todo' ? 'bg-line' : 'bg-ok'}`}
            />
          )}
          <span
            className={`relative z-10 flex size-5.5 items-center justify-center rounded-full border-2 text-[10px] ${
              one.state === 'done'
                ? 'border-ok bg-ok text-white'
                : one.state === 'now'
                  ? 'border-warn bg-card text-warn shadow-[0_0_0_4px] shadow-warn/15'
                  : 'border-neutral-300 bg-card'
            }`}
          >
            {one.state === 'done' ? '✓' : index + 1}
          </span>
          {STAGE_LABEL[one.stage]}
        </li>
      ))}
    </ol>
  );
}

function SlowBox({ detail, run }: { detail: RunDetail; run: AgentRun }) {
  const stop = useStopSession(run.session.id);
  const queue = useRunQueue(run.session.id);
  const allow = useAddNetworkDomain();
  const { slow } = detail;
  if (!slow) return null;
  const rows: [string, string | null][] = [
    ['Right now', slow.right_now],
    ['Likely cause', slow.likely_cause],
    ['Also', slow.also],
    ['Suggest', slow.suggestion],
  ];
  const error = [stop, queue.queue, queue.sendNow, allow].find((one) => one.isError)?.error;
  return (
    <section className="mb-4 overflow-hidden rounded-xl border border-warn/35 bg-warn/[0.07] p-3.5 shadow-[inset_4px_0_0] shadow-warn">
      <Heading>
        <span className="text-warn">Why this run is slow</span>
      </Heading>
      <dl className="m-0 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-xs">
        {rows.map(([name, text]) =>
          text === null ? null : (
            <div key={name} className="contents">
              <dt className="font-semibold text-warn">{name}</dt>
              <dd className="m-0">{text}</dd>
            </div>
          ),
        )}
      </dl>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button variant="primary" className="px-3 py-1 text-xs" disabled={stop.isPending} onClick={() => stop.mutate()}>
          {stop.isPending ? <Spinner /> : null}
          Stop the run
        </Button>
        <Button
          className="px-3 py-1 text-xs"
          title="Stops the run, then sends the agent a message to skip the step"
          disabled={queue.queue.isPending || queue.sendNow.isPending}
          onClick={() => queue.queue.mutate(SKIP_TEXT, { onSuccess: () => queue.sendNow.mutate() })}
        >
          Stop and tell the agent to skip it
        </Button>
        {slow.blocked_host && (
          <Button
            className="px-3 py-1 text-xs"
            title="Adds the host to the Network allowlist for every later run"
            disabled={allow.isPending}
            onClick={() => allow.mutate(slow.blocked_host as string)}
          >
            {allow.isSuccess ? `${slow.blocked_host} allowed` : `Allow ${slow.blocked_host}`}
          </Button>
        )}
        <Link to="/agents" className="self-center text-xs">
          Open Network allowlist →
        </Link>
      </div>
      {error && (
        <p role="alert" className="m-0 mt-2 text-[11px] text-accent-700">
          {error.message}
        </p>
      )}
    </section>
  );
}

function FailureBox({ failure, run }: { failure: Failure; run: AgentRun }) {
  const controls = useRunControls(run.session.id);
  const allow = useAddNetworkDomain();
  const [copied, copy] = useCopy();
  const tone = failureTone(failure);
  const rows: [string, string][] = [
    ['What happened', failure.what_happened],
    ['Likely cause', failure.likely_cause],
    ['What to do', failure.what_to_do],
  ];
  const needsAccount = failure.kind === FailureKind.RateLimited || failure.kind === FailureKind.SignedOut;
  const error = [controls.resume, allow].find((one) => one.isError)?.error;
  return (
    <section className={`mb-4 rounded-xl border p-3.5 ${tone.box}`}>
      <Heading note={FAILURE_LABEL[failure.kind]}>
        <span className={tone.label}>Why this run ended</span>
      </Heading>
      <dl className="m-0 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-xs">
        {rows.map(([name, text]) => (
          <div key={name} className="contents">
            <dt className={`font-semibold ${tone.label}`}>{name}</dt>
            <dd className="m-0">{text}</dd>
          </div>
        ))}
      </dl>
      {failure.raw && (
        <pre className="m-0 mt-2.5 overflow-x-auto rounded-lg bg-neutral-900 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-neutral-100">
          {failure.raw}
        </pre>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {failure.blocked_host && run.can_resume && (
          <Button
            variant="primary"
            className="px-3 py-1 text-xs"
            disabled={allow.isPending || controls.resume.isPending}
            onClick={() => allow.mutate(failure.blocked_host as string, { onSuccess: () => controls.resume.mutate() })}
          >
            Allow {failure.blocked_host} and Retry
          </Button>
        )}
        {needsAccount && (
          <Link to="/agents" className="text-xs font-semibold">
            Open Agents &amp; accounts →
          </Link>
        )}
        {run.can_resume && (
          <Button
            variant={failure.blocked_host ? 'secondary' : 'primary'}
            className="px-3 py-1 text-xs"
            disabled={controls.resume.isPending}
            onClick={() => controls.resume.mutate()}
          >
            {controls.resume.isPending ? <Spinner /> : null}
            Retry
          </Button>
        )}
        {failure.raw && (
          <Button className="px-3 py-1 text-xs" onClick={() => copy(failure.raw as string)}>
            {copyLabel(copied, 'Copy error')}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="m-0 mt-2 text-[11px] text-accent-700">
          {error.message}
        </p>
      )}
    </section>
  );
}

/** Where the time went: one bar, and a line per phase. */
function Split({ split }: { split: RunDetail['run']['split'] }) {
  const total = split.reduce((sum, part) => sum + part.ms, 0);
  if (total <= 0) return null;
  const top = [...split].sort((a, b) => b.ms - a.ms)[0];
  return (
    <section className="mb-4">
      <Heading
        note={
          top && top.ms / total >= 0.5
            ? `${Math.round((top.ms / total) * 100)}% in ${PHASE[top.phase].label.toLowerCase()}`
            : undefined
        }
      >
        Where the {duration(total)} went
      </Heading>
      <div className="flex h-4.5 gap-0.5 overflow-hidden rounded-full bg-neutral-200">
        {split
          .filter((part) => part.ms > 0)
          .map((part) => (
            <span
              key={part.phase}
              className="block h-full rounded-full"
              style={{ width: `${(part.ms / total) * 100}%`, background: PHASE[part.phase].color }}
            />
          ))}
      </div>
      <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-5 gap-y-1 p-0 text-[11px]">
        {split.map((part) => (
          <li key={part.phase} className="flex items-center gap-1.5 text-neutral-800">
            <span
              aria-hidden
              className="size-2.25 flex-none rounded-[3px]"
              style={{ background: PHASE[part.phase].color }}
            />
            {PHASE[part.phase].label}
            <span className="font-mono text-text">{duration(part.ms)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One lane per agent: the main agent and each subagent, with a bar for every call along the run's time. */
function Timeline({ run, steps }: { run: AgentRun; steps: RunStep[] }) {
  if (run.started_at === null || steps.length === 0) return null;
  const t0 = Date.parse(run.started_at);
  const t1 = run.running || run.finished_at === null ? Date.now() : Date.parse(run.finished_at);
  const span = Math.max(1, t1 - t0);
  const at = (iso: string) => Math.min(100, Math.max(0, ((Date.parse(iso) - t0) / span) * 100));
  const lanes: { id: string | null; name: string; sub: boolean }[] = [
    { id: null, name: 'Main agent', sub: false },
    ...run.subagents.map((one) => ({ id: one.id, name: one.description, sub: true })),
  ];
  const mid = new Date(t0 + span / 2).toISOString();
  return (
    <section className="mb-4">
      <Heading note="main agent and subagents">Timeline</Heading>
      <div className="rounded-xl border border-line bg-card p-2.5">
        {lanes.map((lane) => {
          const mine = steps.filter((step) => step.agent_id === lane.id);
          const life = run.subagents.find((one) => one.id === lane.id);
          return (
            <div key={lane.id ?? 'main'} className="my-1.5 grid grid-cols-[8rem_1fr] items-center gap-2.5 text-[11px]">
              <span className={`truncate ${lane.sub ? 'pl-2.5 text-neutral-700' : 'font-medium'}`} title={lane.name}>
                {lane.name}
              </span>
              <span className="relative h-4.5 rounded-md bg-neutral-100">
                {life && (
                  <span
                    aria-hidden
                    className="absolute top-1 h-2.5 rounded-sm bg-neutral-300/60"
                    style={{
                      left: `${at(life.started_at)}%`,
                      width: `${Math.max(0.6, at(life.finished_at ?? new Date(t1).toISOString()) - at(life.started_at))}%`,
                    }}
                  />
                )}
                {mine.map((step) => (
                  <span
                    key={step.id}
                    title={`${shown(step.summary)} · ${duration((step.finished_at ? Date.parse(step.finished_at) : t1) - Date.parse(step.started_at))}${step.ok === false ? ' · failed' : ''}`}
                    className="absolute top-0.75 h-3 rounded-sm"
                    style={{
                      left: `${at(step.started_at)}%`,
                      width: `${Math.max(0.6, at(step.finished_at ?? new Date(t1).toISOString()) - at(step.started_at))}%`,
                      background: step.ok === false ? 'var(--color-accent)' : PHASE[step.phase].color,
                    }}
                  />
                ))}
              </span>
            </div>
          );
        })}
        <div className="grid grid-cols-[8rem_1fr] gap-2.5 font-mono text-[10px] text-neutral-700">
          <span />
          <span className="flex justify-between">
            <span>{clock(run.started_at)}</span>
            <span>{clock(mid)}</span>
            <span>{run.running ? 'now' : clock(new Date(t1).toISOString())}</span>
          </span>
        </div>
      </div>
    </section>
  );
}

/** Every call the agent made, newest last, with the slowest and the failed ones marked. */
function Trace({ steps, running }: { steps: RunStep[]; running: boolean }) {
  const [all, setAll] = useState(false);
  if (steps.length === 0) return null;
  const took = (step: RunStep) =>
    (step.finished_at ? Date.parse(step.finished_at) : Date.now()) - Date.parse(step.started_at);
  const slowest = steps.reduce((best, step) => (took(step) > took(best) ? step : best), steps[0] as RunStep);
  const list = all ? steps : steps.slice(-12);
  return (
    <section className="mb-2">
      <Heading note={`${steps.length} calls`}>Steps</Heading>
      <ol className="m-0 list-none border-l-2 border-line p-0 pl-3.5">
        {list.map((step) => {
          const hot = step.id === slowest.id && took(slowest) >= 60_000;
          const open = step.finished_at === null;
          return (
            <li
              key={step.id}
              className={`relative my-0.5 grid grid-cols-[4.5rem_1fr_auto] items-center gap-2.5 rounded-lg px-2.5 py-1 text-[11.5px] ${
                step.ok === false ? 'bg-accent-100' : hot || (open && running) ? 'bg-warn/10' : ''
              }`}
            >
              <span
                aria-hidden
                className={`absolute top-2.5 -left-5 size-2 rounded-full border-2 border-card ${step.ok === false ? 'bg-accent' : hot || open ? 'bg-warn' : 'bg-neutral-400'}`}
              />
              <span className="font-mono text-[10.5px] whitespace-nowrap text-neutral-700">
                {clock(step.started_at)}
              </span>
              <span className="min-w-0">
                <code className="break-all font-mono text-[11px]">{shown(step.summary)}</code>
                {step.agent_id !== null && <span className="ml-1.5 text-neutral-700">· subagent</span>}
                {step.error && <span className="block truncate text-accent-700">{step.error}</span>}
              </span>
              <span
                className={`font-mono text-[11px] ${step.ok === false ? 'font-bold text-accent-700' : hot || open ? 'font-bold text-warn' : ''}`}
              >
                {duration(took(step))}
                {open && running ? ' ●' : ''}
              </span>
            </li>
          );
        })}
      </ol>
      {steps.length > 12 && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-xs text-accent-700"
        >
          {all ? 'Show the last 12' : `Show all ${steps.length}`}
        </button>
      )}
    </section>
  );
}

function QueueBox({ run }: { run: AgentRun }) {
  const queue = useRunQueue(run.session.id);
  const text = run.session.queued_message;
  if (text === null) return null;
  return (
    <section className="mb-4 flex items-center gap-2.5 rounded-lg border border-info/30 bg-info/[0.07] px-3 py-2 text-xs">
      <span className="flex-none rounded-full bg-info/14 px-2 py-px font-mono text-[11px] text-info">
        {run.running ? '1 queued' : 'on hold'}
      </span>
      <span className="min-w-0 flex-1 truncate" title={text}>
        “{text}”
      </span>
      <Button
        className="px-2.5 py-0.5 text-xs"
        disabled={queue.sendNow.isPending}
        onClick={() => queue.sendNow.mutate()}
      >
        Send now
      </Button>
      <Button
        className="px-2.5 py-0.5 text-xs"
        disabled={queue.takeBack.isPending}
        onClick={() => queue.takeBack.mutate()}
      >
        Take back
      </Button>
    </section>
  );
}

/** Everything about one run that does not fit its card: why, where the time went, every call, what is queued. */
export function RunDetailPanel({ run }: { run: AgentRun }) {
  const detail = useRunDetail(run.session.id);
  const { session } = run;
  const info: [string, string][] = [
    ['Kind', session.kind.replace('_', ' ')],
    ['Started', run.started_at ? clock(run.started_at) : '—'],
    ['Access', session.access_mode.replace('_', ' ')],
    ['Model', session.model],
    ...(run.cost_usd !== null
      ? ([['Usage', `${money(run.cost_usd)} est.${run.tokens ? ` · ${tokens(run.tokens)} tokens` : ''}`]] as [
          string,
          string,
        ][])
      : []),
  ];
  return (
    <div className="border-t border-line px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <Link to={sessionPath(session.id)} className="font-semibold">
          Open Session →
        </Link>
        {session.repo_id !== null && session.pr_number !== null && (
          <Link to={pullRequestPath(session.repo_id, session.pr_number)}>Pull request #{session.pr_number} →</Link>
        )}
        {session.alert_id && <Link to={alertPath(session.alert_id)}>Monitor Alert →</Link>}
        <dl className="m-0 ml-auto flex flex-wrap gap-x-4 text-[11px] text-neutral-700">
          {info.map(([name, value]) => (
            <div key={name} className="flex gap-1">
              <dt>{name}</dt>
              <dd className="m-0 font-mono text-text">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <QueueBox run={run} />
      {detail.isPending && <p className="m-0 text-xs text-neutral-700">Reading the run…</p>}
      {detail.isError && (
        <p role="alert" className="m-0 text-xs text-accent-700">
          {detail.error.message}
        </p>
      )}
      {detail.data && (
        <>
          <Stepper stages={detail.data.stages} />
          <SlowBox detail={detail.data} run={run} />
          {detail.data.failure && <FailureBox failure={detail.data.failure} run={run} />}
          <Split split={detail.data.run.split} />
          <Timeline run={detail.data.run} steps={detail.data.steps} />
          <Trace steps={detail.data.steps} running={detail.data.run.running} />
          {detail.data.steps.length === 0 && (
            <p className="m-0 text-xs text-neutral-700">
              The console kept no steps for this run: it started before steps were kept.
            </p>
          )}
        </>
      )}
    </div>
  );
}
