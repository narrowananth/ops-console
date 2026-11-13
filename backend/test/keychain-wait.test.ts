import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ErrorCode, StepBlock, type WsEvent } from '@ops-console/shared';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime';
import { ConnectionsModule } from '../src/connections/connections.module';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { STORE, type Store } from '../src/db/store';
import { type KeychainEntry, LoginKeychain } from '../src/keychain/keychain';
import { KeychainWaitTracker } from '../src/keychain/keychain-wait';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { JobSteps } from '../src/playbooks/job-steps';
import { TerminalsModule } from '../src/terminals/terminals.module';
import { type AgentDaemon, api, listen, startAgentDaemon, until } from './agent-fixtures';
import { FakeConnectionTester } from './fakes/connection-tester';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeProbe } from './fakes/probe';

const MESSAGE = "Keychain is waiting for the Mac's password prompt";

/** The login Keychain, answering from memory until `hang` is set; then the Mac waits for a password nobody types. */
class PromptingKeychain {
  hang = false;
  private readonly values = new Map<string, string>();

  entry = (_service: string, key: string): KeychainEntry => ({
    setPassword: (value) => (this.hang ? new Promise(() => {}) : Promise.resolve(void this.values.set(key, value))),
    getPassword: () => (this.hang ? new Promise(() => {}) : Promise.resolve(this.values.get(key) ?? null)),
    deletePassword: () => (this.hang ? new Promise(() => {}) : Promise.resolve(this.values.delete(key))),
  });
}

const running: AgentDaemon[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** Waits are 100 ms to show and 400 ms to fail, in place of 10 and 60 seconds. */
async function start() {
  const prompt = new PromptingKeychain();
  const wait = new KeychainWaitTracker(100);
  const keychain = new LoginKeychain('test', undefined, { entry: prompt.entry, wait, callMs: 400 });
  const daemon = await startAgentDaemon({
    keychain,
    keychainWait: wait,
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console/bin/ops-console' }),
      ConnectionsModule.forRoot({ tester: new FakeConnectionTester(), launchDir: '/opt/ops-console/app/launch' }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      TerminalsModule.forRoot(),
    ],
  });
  running.push(daemon);
  return { daemon, prompt };
}

const waitOf = async (daemon: AgentDaemon) => (await api(daemon).get('/terminals/keychain-wait')).body.data;

/** A stand-in for CLIProxy, so the daemon lets its setting turn on. */
async function fakeCliProxy(): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5' }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Turns CLIProxy on, so every run reads its key from the Keychain before it starts. */
async function cliProxyOn(daemon: AgentDaemon, prompt: PromptingKeychain) {
  const address = await fakeCliProxy();
  await api(daemon).put('/cliproxy/key', { key: 'sk-test' });
  await api(daemon).patch('/settings', { cliproxy: { enabled: true, address } });
  prompt.hang = true;
}

const waiting = (events: WsEvent[]) =>
  events.flatMap((event) => (event.event === 'keychain.wait_changed' ? [event.data] : []));

describe('Keychain wait', () => {
  it('is quiet while no call is pending (Behavior 14)', async () => {
    const { daemon } = await start();
    expect(await waitOf(daemon)).toEqual({ waiting: false, since: null, pending: 0 });
  });

  it('starts the wait when its timer fires, even if the clock reads a millisecond short of the threshold', () => {
    vi.useFakeTimers();
    try {
      const wait = new KeychainWaitTracker(100);
      const heard: boolean[] = [];
      wait.onChange((state) => heard.push(state.waiting));
      const end = wait.begin();
      vi.setSystemTime(Date.now() - 1);
      vi.advanceTimersByTime(100);
      expect(heard).toEqual([true]);
      end();
      expect(heard).toEqual([true, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a wait after the threshold, tells every browser, and clears when the call times out (Behavior 13, 14, 15)', async () => {
    const { daemon, prompt } = await start();
    await cliProxyOn(daemon, prompt);
    const { events } = await listen(daemon);
    const other = await listen(daemon);

    const summary = daemon.app.get(AgentRuntime).runFor(daemon.createSession(), 'go', null, {}).finished;
    const shown = await until(
      () => waitOf(daemon),
      (state) => state.waiting,
      'the wait to show',
    );
    expect(shown).toMatchObject({ waiting: true, pending: 1, since: expect.any(String) });

    const done = await summary;
    expect(done).toMatchObject({ ok: false, failure: MESSAGE });
    expect(await waitOf(daemon)).toEqual({ waiting: false, since: null, pending: 0 });
    await until(
      () => waiting(events),
      (heard) => heard.length === 2,
      'both keychain.wait_changed events',
    );
    const expected = [
      { waiting: true, since: shown.since, pending: 1 },
      { waiting: false, since: null, pending: 0 },
    ];
    expect(waiting(events)).toEqual(expected);
    // Every open browser hears it, and a reloaded page reads the same state from the daemon (Behavior 15).
    await until(
      () => waiting(other.events),
      (heard) => heard.length === 2,
      'the second browser to hear both',
    );
    expect(waiting(other.events)).toEqual(expected);
  });

  it('fails a run that needs the Keychain before it starts, with keychain_timeout (Behavior 13)', async () => {
    const { daemon, prompt } = await start();
    await cliProxyOn(daemon, prompt);
    const id = daemon.createSession();
    const { events } = await listen(daemon);
    await daemon.app.get(AgentRuntime).runFor(id, 'go', null, {}).finished;
    expect(daemon.sdk.calls).toHaveLength(0);
    const finished = await until(
      () => events.flatMap((event) => (event.event === 'session.finished' ? [event.data] : [])),
      (list) => list.length === 1,
      'session.finished',
    );
    expect(finished[0]).toMatchObject({ status: 'failed', error_code: ErrorCode.KeychainTimeout });
  });

  it('ends a Playbook step failed with the message, and does not run the next (Behavior 13)', async () => {
    const { daemon, prompt } = await start();
    await cliProxyOn(daemon, prompt);
    const steps = daemon.app.get(JobSteps);
    const job = { kind: 'reply_check', id: 'job-1' } as const;
    const store = daemon.app.get<Store>(STORE);
    // The job rows a real job seeds its steps under are beside the point here.
    store.db.run(sql`pragma foreign_keys = off`);
    store.write((tx) =>
      steps.seed(tx, job, [
        { block: StepBlock.TraceLog, title: 'One', instructions: 'first', writes: false },
        { block: StepBlock.TraceLog, title: 'Two', instructions: 'second', writes: false },
      ]),
    );
    const failure = await steps.run({
      job,
      sessionId: daemon.createSession(),
      brief: 'brief',
      rules: null,
    });
    expect(failure).toBe(`Step 1 · One failed: ${MESSAGE}`);
    expect(steps.rows(job).map((row) => [row.title, row.status, row.summary])).toEqual([
      ['One', 'failed', MESSAGE],
      ['Two', 'pending', null],
    ]);
    expect(daemon.sdk.calls).toHaveLength(0);
  });
});
