import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime';
import { type AgentDaemon, api, gate, startAgentDaemon, until } from './agent-fixtures';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

async function start(jobRunLimit: number) {
  const daemon = await startAgentDaemon({ jobRunLimit });
  running.push(daemon);
  return daemon;
}

describe('job runs past the limit wait their turn', () => {
  it('starts the second job run only when the first ends, and says why it waits', async () => {
    const daemon = await start(1);
    const runtime = daemon.app.get(AgentRuntime);
    const hold = gate();
    daemon.sdk.script({ wait: hold.promise });
    const first = runtime.runFor(daemon.createSession(), 'one');
    await until(
      () => daemon.sdk.calls.length,
      (count) => count === 1,
      'the first run',
    );
    const waiting = daemon.createSession();
    const second = runtime.runFor(waiting, 'two');
    const messages = await api(daemon).get(`/sessions/${waiting}/messages`);
    expect(messages.body.data.at(-1).parts).toContainEqual({
      kind: 'step',
      text: 'Waiting for a free place: 1 job run ahead',
    });
    expect(daemon.sdk.calls).toHaveLength(1);

    hold.open();
    expect((await first.finished).ok).toBe(true);
    expect((await second.finished).ok).toBe(true);
    expect(daemon.sdk.calls).toHaveLength(2);
  });

  it('never makes the operator wait: a message goes out while job runs fill the places', async () => {
    const daemon = await start(1);
    const runtime = daemon.app.get(AgentRuntime);
    const hold = gate();
    daemon.sdk.script({ wait: hold.promise });
    const job = runtime.runFor(daemon.createSession(), 'job');
    await until(
      () => daemon.sdk.calls.length,
      (count) => count === 1,
      'the job run',
    );
    const chat = daemon.createSession();
    expect((await api(daemon).post(`/sessions/${chat}/messages`, { text: 'hello' })).status).toBe(202);
    await until(
      () => daemon.sdk.calls.length,
      (count) => count === 2,
      'the chat run, with the job run still going',
    );
    hold.open();
    await job.finished;
  });

  it('stops a run that waits for a place, and it never starts', async () => {
    const daemon = await start(1);
    const runtime = daemon.app.get(AgentRuntime);
    const hold = gate();
    daemon.sdk.script({ wait: hold.promise });
    const first = runtime.runFor(daemon.createSession(), 'one');
    await until(
      () => daemon.sdk.calls.length,
      (count) => count === 1,
      'the first run',
    );
    const waiting = daemon.createSession();
    const second = runtime.runFor(waiting, 'two');
    runtime.stop(waiting);
    expect(await second.finished).toMatchObject({ ok: false, stopped: true });
    expect(daemon.sdk.calls).toHaveLength(1);
    hold.open();
    await first.finished;
  });
});

describe('stopping the daemon', () => {
  it('ends a run in flight before the database closes', async () => {
    const daemon = await startAgentDaemon();
    const hold = gate();
    daemon.sdk.script({ wait: hold.promise });
    const runtime = daemon.app.get(AgentRuntime);
    runtime.runFor(daemon.createSession(), 'one');
    await until(
      () => daemon.sdk.calls.length,
      (count) => count === 1,
      'the run',
    );
    const unhandled: unknown[] = [];
    const note = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', note);
    const aborted = () => daemon.sdk.calls[0]?.options.abortController?.signal.aborted;
    expect(aborted()).toBe(false);
    await daemon.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('unhandledRejection', note);
    expect(aborted()).toBe(true);
    expect(unhandled).toEqual([]);
  });
});
