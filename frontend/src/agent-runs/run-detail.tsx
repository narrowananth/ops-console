import { type AgentRun, type Failure, FailureKind, type RunDetail, RunPhase, type RunStep } from '@ops-console/shared';
import { type ReactNode, useState } from 'react';
import { Spinner } from '../components/ui/button';
import { duration } from '../components/ui/elapsed';
import { copyLabel, useCopy } from '../lib/clipboard';
import {
  useAddNetworkDomain,
  useAgentAccounts,
  useRunControls,
  useRunDetail,
  useRunQueue,
  useStopSession,
} from '../lib/queries';
import { alertPath, pullRequestPath, sessionPath } from '../workspace/links';
import { Pill, PillLink } from './run-controls';
import {
  ACCESS_NAME,
  clock,
  FAILURE_LABEL,
  failureTone,
  KIND_NAME,
  MODEL_NAME,
  money,
  PHASE,
  STAGE_LABEL,
  tokens,
} from './run-look';

/** What the agent is told when the operator stops a run for taking too long. */
const SKIP_TEXT =
  'That step was taking too long, so I stopped it. Do not wait on it again: skip it or mock the call, then carry on.';

const shown = (summary: string) => (summary.startsWith('$ ') ? summary.slice(2) : summary);
const baseName = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;

function Heading({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <h3 className="m-0 mb-2 flex items-baseline gap-2 text-[13px] font-bold">
      {children}
      {note && <small className="text-[11px] font-normal text-neutral-700">{note}</small>}
    </h3>
  );
}

function Bulb({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`size-4 flex-none ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.4 1 2.5h6c0-1.1.3-1.8 1-2.5A6 6 0 0 0 12 3z" />
    </svg>
  );
}

/** The run's usual order of work, with where it is now. Read from the tools it used, so it can be wrong. */
function Stepper({ stages }: { stages: RunDetail['stages'] }) {
  return (
    <ol
      aria-label="Where the run is"
      className="m-0 mb-5 flex list-none p-0"
      title="Read from the tools the run used, so a run that works another way can show a stage it skipped as done."
    >
      {stages.map((one, index) => (
        <li
          key={one.stage}
          aria-current={one.state === 'now' ? 'step' : undefined}
          className={`relative flex flex-1 flex-col items-center gap-1.5 text-center text-[11px] ${one.state === 'todo' ? 'text-neutral-700' : 'text-text'} ${one.state === 'now' ? 'font-bold' : ''}`}
        >
          {index > 0 && (
            <span
              aria-hidden
              className={`absolute top-3.5 right-1/2 h-0.5 w-full ${one.state === 'todo' ? 'bg-line' : 'bg-ok'}`}
            />
          )}
          <span
            className={`relative z-10 flex size-7 items-center justify-center rounded-full border-2 text-[11px] ${
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
    <section className="mb-5 rounded-xl border border-warn/35 bg-warn/[0.08] p-4">
      <Heading>
        <span className="flex items-center gap-1.5 text-warn">
          <Bulb />
          Why this run is slow
        </span>
      </Heading>
      <dl className="m-0 grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-xs">
        {rows.map(([name, text]) =>
          text === null ? null : (
            <div key={name} className="contents">
              <dt className="font-bold text-warn">{name}</dt>
              <dd className="m-0">{text}</dd>
            </div>
          ),
        )}
      </dl>
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Pill dark disabled={stop.isPending} onClick={() => stop.mutate()}>
          {stop.isPending ? <Spinner /> : <span aria-hidden className="size-2 rounded-[2px] bg-current" />}
          Stop the run
        </Pill>
        <Pill
          title="Stops the run, then sends the agent a message to skip the step"
          disabled={queue.queue.isPending || queue.sendNow.isPending}
          onClick={() => queue.queue.mutate(SKIP_TEXT, { onSuccess: () => queue.sendNow.mutate() })}
        >
          Stop and tell the agent to skip it
        </Pill>
        {slow.blocked_host && (
          <Pill
            title="Adds the host to the Network allowlist for every later run"
            disabled={allow.isPending}
            onClick={() => allow.mutate(slow.blocked_host as string)}
          >
            {allow.isSuccess ? `${slow.blocked_host} allowed` : `Allow ${slow.blocked_host}`}
          </Pill>
        )}
        <PillLink to="/agents">Open Network allowlist</PillLink>
      </div>
      {error && (
        <p role="alert" className="m-0 mt-2 text-[11px] text-accent-700">
          {error.message}
        </p>
      )}
    </section>
  );
}

/** One line of a failure: a small icon, what it is, and the words. */
function FailureRow({ icon, label, tone, text }: { icon: string; label: string; tone: string; text: string }) {
  return (
    <div className="mb-2.5 grid grid-cols-[1.25rem_1fr] gap-x-2.5">
      <span
        aria-hidden
        className={`mt-px flex size-5 items-center justify-center rounded-full border text-[10px] font-bold ${tone}`}
      >
        {icon}
      </span>
      <div>
        <div className={`font-mono text-[10px] font-bold tracking-wider uppercase ${tone.split(' ').at(-1)}`}>
          {label}
        </div>
        <div className="text-[12.5px]">{text}</div>
      </div>
    </div>
  );
}

function FailureBox({ failure, run }: { failure: Failure; run: AgentRun }) {
  const controls = useRunControls(run.session.id);
  const allow = useAddNetworkDomain();
  const [copied, copy] = useCopy();
  const tone = failureTone(failure);
  const label = tone.label;
  const iconTone = `border-current ${label}`;
  const needsAccount = failure.kind === FailureKind.RateLimited || failure.kind === FailureKind.SignedOut;
  const error = [controls.resume, allow].find((one) => one.isError)?.error;
  return (
    <section className={`mb-5 rounded-xl border p-4 ${tone.box}`}>
      <Heading note={FAILURE_LABEL[failure.kind]}>
        <span className={label}>Why this run ended</span>
      </Heading>
      <FailureRow icon="?" label="What happened" tone={iconTone} text={failure.what_happened} />
      <FailureRow icon="!" label="Likely cause" tone={iconTone} text={failure.likely_cause} />
      <FailureRow icon="✓" label="What to do" tone={iconTone} text={failure.what_to_do} />
      {failure.raw && (
        <pre className="m-0 mt-3 overflow-x-auto rounded-lg bg-neutral-900 px-3.5 py-2.5 font-mono text-[11px] whitespace-pre-wrap text-neutral-100">
          {failure.raw}
        </pre>
      )}
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {failure.blocked_host && run.can_retry && (
          <Pill
            dark
            disabled={allow.isPending || controls.resume.isPending}
            onClick={() => allow.mutate(failure.blocked_host as string, { onSuccess: () => controls.resume.mutate() })}
          >
            Allow {failure.blocked_host} and Retry
          </Pill>
        )}
        {run.can_retry && (
          <Pill
            dark={!failure.blocked_host}
            disabled={controls.resume.isPending}
            onClick={() => controls.resume.mutate()}
          >
            {controls.resume.isPending ? <Spinner /> : null}
            {failure.blocked_host ? 'Retry only' : 'Retry'}
          </Pill>
        )}
        {needsAccount && <PillLink to="/agents">Open Agents &amp; accounts</PillLink>}
        {failure.raw && <Pill onClick={() => copy(failure.raw as string)}>{copyLabel(copied, 'Copy error')}</Pill>}
      </div>
      {error && (
        <p role="alert" className="m-0 mt-2 text-[11px] text-accent-700">
          {error.message}
        </p>
      )}
    </section>
  );
}

/** Where the time went: one bar, and a legend of each phase with its time. */
function Split({ split }: { split: RunDetail['run']['split'] }) {
  const total = split.reduce((sum, part) => sum + part.ms, 0);
  if (total <= 0) return null;
  const top = [...split].sort((a, b) => b.ms - a.ms)[0];
  return (
    <section className="mb-5">
      <Heading
        note={
          top && top.ms / total >= 0.5
            ? `${Math.round((top.ms / total) * 100)}% in ${PHASE[top.phase].label.toLowerCase()}`
            : undefined
        }
      >
        Where the {duration(total)} went
      </Heading>
      <div className="flex h-6 gap-0.5 overflow-hidden rounded-full bg-neutral-200">
        {split
          .filter((part) => part.ms > 0)
          .map((part) => (
            <span
              key={part.phase}
              title={`${PHASE[part.phase].label}: ${duration(part.ms)}`}
              className="block h-full rounded-full"
              style={{ width: `${(part.ms / total) * 100}%`, background: PHASE[part.phase].color }}
            />
          ))}
      </div>
      <ul className="m-0 mt-3 grid list-none grid-cols-3 gap-x-8 gap-y-1.5 p-0 text-xs max-[760px]:grid-cols-1">
        {split.map((part) => (
          <li key={part.phase} className="flex items-center gap-2 text-neutral-800">
            <span
              aria-hidden
              className="size-2.5 flex-none rounded-full"
              style={{ background: PHASE[part.phase].color }}
            />
            {PHASE[part.phase].label}
            <span className="ml-auto font-mono text-text">{duration(part.ms)}</span>
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
  const ticks = [0, 1 / 3, 2 / 3, 1].map((part) => new Date(t0 + span * part).toISOString());
  return (
    <section className="mb-5">
      <Heading note="main agent and subagents">Timeline</Heading>
      <div className="rounded-xl border border-line bg-card p-3">
        <div className="relative">
          <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 left-[8.5rem] flex">
            {[25, 50, 75].map((left) => (
              <span key={left} className="absolute inset-y-0 border-l border-line" style={{ left: `${left}%` }} />
            ))}
            {run.running && <span className="absolute inset-y-0 right-0 border-l-2 border-dashed border-text/35" />}
          </div>
          {lanes.map((lane) => {
            const mine = steps.filter((step) => step.agent_id === lane.id);
            const life = run.subagents.find((one) => one.id === lane.id);
            const bad = mine.find((step) => step.ok === false);
            return (
              <div key={lane.id ?? 'main'} className="my-2 grid grid-cols-[8rem_1fr] items-center gap-2.5 text-[11px]">
                <span
                  className={`truncate ${lane.sub ? 'pl-2.5 text-neutral-700' : 'font-semibold'}`}
                  title={lane.name}
                >
                  {lane.name}
                </span>
                <span className="relative h-4.5">
                  {life && (
                    <span
                      aria-hidden
                      className="absolute top-1.5 h-1.5 rounded-sm bg-neutral-300/60"
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
                      className="absolute top-0.5 h-3.5 rounded-md"
                      style={{
                        left: `${at(step.started_at)}%`,
                        width: `${Math.max(0.8, at(step.finished_at ?? new Date(t1).toISOString()) - at(step.started_at))}%`,
                        background: step.ok === false ? 'var(--color-accent)' : PHASE[step.phase].color,
                      }}
                    />
                  ))}
                  {bad && (
                    <span
                      aria-hidden
                      className="absolute -top-0.5 flex size-5 -translate-x-1/2 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-white"
                      style={{ left: `${Math.min(97, at(bad.finished_at ?? bad.started_at))}%` }}
                    >
                      !
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-[8rem_1fr] gap-2.5 font-mono text-[10px] text-neutral-700">
          <span />
          <span className="flex justify-between">
            {ticks.map((iso, index) => (
              <span key={iso}>{index === ticks.length - 1 && run.running ? `${clock(iso)} now` : clock(iso)}</span>
            ))}
          </span>
        </div>
      </div>
    </section>
  );
}

type Row = {
  id: string;
  at: string;
  text: ReactNode;
  ms: number;
  open: boolean;
  tone: 'plain' | 'bad' | 'slow';
  error: string | null;
};

const tookMs = (step: RunStep) =>
  (step.finished_at ? Date.parse(step.finished_at) : Date.now()) - Date.parse(step.started_at);

/** What a file call touched: the name only, the rest of the path is in the step's title. */
const subjectOf = (step: RunStep) => baseName(step.summary.replace(/^\S+\s/, ''));

/** The calls in the order made, with a run of reads or of edits by one agent joined into one line. */
function rowsOf(steps: RunStep[]): Row[] {
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
      at: first.started_at,
      ms: (last.finished_at ? Date.parse(last.finished_at) : Date.now()) - Date.parse(first.started_at),
      open: last.finished_at === null,
      tone: 'plain',
      error: null,
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
      step.tool !== 'Agent';
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
    rows.push({
      id: step.id,
      at: step.started_at,
      ms: tookMs(step),
      open: step.finished_at === null,
      tone: step.ok === false ? 'bad' : 'plain',
      error: step.error,
      text: (
        <>
          {command ? 'Ran ' : ''}
          <code className="font-mono text-[11px] break-all">{shown(step.summary)}</code>
          {step.agent_id !== null && <span className="ml-1.5 text-neutral-700">· subagent</span>}
        </>
      ),
    });
  }
  flush();
  return rows;
}

/** Every call the agent made, oldest first, with the slowest one marked and a failed one in red. */
function Trace({ steps, running }: { steps: RunStep[]; running: boolean }) {
  const [all, setAll] = useState(false);
  if (steps.length === 0) return null;
  const rows = rowsOf(steps);
  const slowest = rows.reduce((best, row) => (row.ms > best.ms ? row : best), rows[0] as Row);
  const list = all ? rows : rows.slice(-12);
  return (
    <section className="mb-2">
      <Heading note={`${steps.length} calls`}>Steps</Heading>
      <ol className="m-0 list-none border-l-2 border-line p-0 pl-4">
        {list.map((row) => {
          const hot = row.id === slowest.id && row.ms >= 60_000;
          const live = row.open && running;
          return (
            <li
              key={row.id}
              className={`relative my-1 grid grid-cols-[4.5rem_1fr_auto] items-center gap-2.5 rounded-lg px-3 py-1.5 text-[12px] ${
                row.tone === 'bad' ? 'bg-accent-100' : hot || live ? 'bg-warn/10' : ''
              }`}
            >
              <span
                aria-hidden
                className={`absolute top-3 -left-6 size-2.5 rounded-full border-2 border-card ${row.tone === 'bad' ? 'bg-accent' : hot || live ? 'bg-warn' : 'bg-neutral-400'}`}
              />
              <span className="font-mono text-[10.5px] whitespace-nowrap text-neutral-700">{clock(row.at)}</span>
              <span className="min-w-0">
                {row.text}
                {row.error && <span className="block truncate text-accent-700">{row.error}</span>}
              </span>
              <span
                className={`font-mono text-[11px] ${row.tone === 'bad' ? 'font-bold text-accent-700' : hot || live ? 'font-bold text-warn' : ''}`}
              >
                {duration(row.ms)}
                {live ? ' ●' : ''}
              </span>
            </li>
          );
        })}
      </ol>
      {rows.length > 12 && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-xs text-accent-700"
        >
          {all ? 'Show the last 12' : `Show all ${rows.length}`}
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

/** Everything about one run that does not fit its card: where it runs, why, where the time went, every call. */
export function RunDetailPanel({ run, repoName }: { run: AgentRun; repoName: (id: string | null) => string }) {
  const detail = useRunDetail(run.session.id);
  const accounts = useAgentAccounts().data?.data ?? [];
  const { session } = run;
  const account = accounts.find((one) => one.id === session.account_id);
  const info: [string, string][] = [
    ['Kind', KIND_NAME[session.kind]],
    ['Started', run.started_at ? clock(run.started_at) : '—'],
    ['Access', ACCESS_NAME[session.access_mode]],
    ['Model', MODEL_NAME[session.model]],
    ...(session.repo_id ? ([['Repo', repoName(session.repo_id)]] as [string, string][]) : []),
    ...(account ? ([['Account', account.email ?? account.label]] as [string, string][]) : []),
    ...(run.cost_usd !== null
      ? ([['Usage', `${money(run.cost_usd)} est.${run.tokens ? ` · ${tokens(run.tokens)} tokens` : ''}`]] as [
          string,
          string,
        ][])
      : []),
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
      <dl className="m-0 mb-4 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-6 gap-y-1.5 text-xs">
        {info.map(([name, value]) => (
          <div key={name} className="flex gap-2">
            <dt className="w-14 flex-none text-neutral-700">{name}</dt>
            <dd className="m-0 min-w-0 truncate font-mono text-text">{value}</dd>
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
