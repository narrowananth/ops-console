import type { AgentRun, RunDetail } from '@ops-console/shared';
import { Spinner } from '../components/ui/button';
import { useAddNetworkDomain, useAllowAndRestart, useRunQueue, useStopSession } from '../lib/queries';
import { Pill, PillLink } from './run-controls';
import { Bulb, Heading } from './run-parts';

/** What the agent is told when the operator stops a run for taking too long. */
const SKIP_TEXT =
  'That step was taking too long, so I stopped it. Do not wait on it again: skip it or mock the call, then carry on.';

export function SlowBox({ detail, run }: { detail: RunDetail; run: AgentRun }) {
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

/**
 * The hosts the Run sandbox refused this run's commands. A command that calls one can wait on it for a very long time,
 * so the box shows while the run goes. The operator allows a host; the agent never does. A run keeps the allowlist it
 * began with, so Allow and restart pauses it and plays it again on the new list.
 */
export function BlockedBox({ run }: { run: AgentRun }) {
  const allow = useAddNetworkDomain();
  const restart = useAllowAndRestart(run.session.id);
  const hosts = run.blocked_hosts;
  if (hosts.length === 0) return null;
  const error = [allow, restart].find((one) => one.isError)?.error;
  return (
    <section className="mb-5 rounded-xl border border-accent-300 bg-accent-100/60 p-4" aria-label="Refused hosts">
      <Heading>
        <span className="text-accent-700">The Run sandbox refused {hosts.length === 1 ? 'a host' : 'these hosts'}</span>
      </Heading>
      <p className="m-0 mb-3 text-xs">
        {run.running
          ? 'A test or command that calls a refused host can wait on it for a long time. The agent cannot add hosts; you can.'
          : 'The agent could not reach these hosts. Allow them, then play the run again.'}{' '}
        {run.running && 'A run keeps the list it started with, so an allowed host reaches the next run.'}
      </p>
      <ul className="m-0 mb-3 flex list-none flex-wrap gap-2 p-0">
        {hosts.map((host) => (
          <li
            key={host}
            className="flex items-center gap-1.5 rounded-full border border-divider bg-card py-0.5 pr-0.5 pl-3"
          >
            <code className="font-mono text-xs">{host}</code>
            <Pill className="py-0.5" disabled={allow.isPending || restart.isPending} onClick={() => allow.mutate(host)}>
              Allow
            </Pill>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {run.running && run.can_resume && (
          <Pill
            dark
            title="Adds the hosts to the Network allowlist, pauses the run and plays it again on the new list"
            disabled={restart.isPending || allow.isPending}
            onClick={() => restart.mutate(hosts)}
          >
            {restart.isPending ? <Spinner /> : null}
            Allow {hosts.length === 1 ? 'it' : 'all'} and restart the run
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
