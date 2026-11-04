import os from 'node:os';
import path from 'node:path';
import { AccessMode, CONNECTOR_SERVERS, ConnectorId, StepBlock } from '@ops-console/shared';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime';
import { STORE, type Store } from '../src/db/store';
import { KEYCHAIN, type Keychain } from '../src/keychain/keychain';
import { JobSteps } from '../src/playbooks/job-steps';
import { type AgentDaemon, api, converse, startAgentDaemon, WORKING_DIR } from './agent-fixtures';
import { tempDir } from './helpers';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

async function start() {
  const daemon = await startAgentDaemon();
  running.push(daemon);
  return daemon;
}

const home = os.homedir();
const sandboxOf = (daemon: AgentDaemon, call = -1) => {
  const options = daemon.sdk.calls.at(call)?.options;
  if (!options?.sandbox) throw new Error('the run had no sandbox');
  return options.sandbox;
};

describe('Run sandbox on agent runs', () => {
  it('sandboxes a run in every Access mode, full included (Behavior 1)', async () => {
    const daemon = await start();
    for (const mode of Object.values(AccessMode)) {
      const id = daemon.createSession({ access_mode: mode });
      await converse(daemon, id, 'go');
      expect(sandboxOf(daemon)).toMatchObject({ enabled: true, allowUnsandboxedCommands: false });
    }
    expect(daemon.sdk.calls).toHaveLength(Object.values(AccessMode).length);
  });

  it('denies the data folder the daemon runs on and writes in the Session’s folder (Behavior 2, 3)', async () => {
    const daemon = await start();
    await converse(daemon, daemon.createSession(), 'go');
    const { filesystem } = sandboxOf(daemon);
    expect(filesystem?.allowWrite).toEqual([WORKING_DIR, '/tmp', '/private/tmp']);
    expect(filesystem?.denyRead).toContain(daemon.dataDir);
    expect(filesystem?.denyRead).toContain(path.join(home, '.ssh'));
    expect(filesystem?.allowRead).toContain(WORKING_DIR);
  });

  it('gives two runs at once each their own folder only (Behavior 6)', async () => {
    const daemon = await start();
    const [a, b] = [await tempDir('scratch-a-'), await tempDir('scratch-b-')];
    const runtime = daemon.app.get(AgentRuntime);
    const first = runtime.runFor(daemon.createSession(), 'one', null, { cwd: a });
    const second = runtime.runFor(daemon.createSession(), 'two', null, { cwd: b });
    await Promise.all([first.finished, second.finished]);
    const writes = daemon.sdk.calls.map((call) => call.options.sandbox?.filesystem?.allowWrite);
    expect(writes).toContainEqual([a, '/tmp', '/private/tmp']);
    expect(writes).toContainEqual([b, '/tmp', '/private/tmp']);
    expect(writes.flat()).toHaveLength(6);
  });

  it('sandboxes a resumed conversation too (Behavior 7)', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    await converse(daemon, id, 'first');
    await converse(daemon, id, 'second');
    expect(daemon.sdk.calls).toHaveLength(2);
    expect(daemon.sdk.calls[1]?.options.resume).toBeTruthy();
    expect(sandboxOf(daemon, 1)).toMatchObject({ enabled: true, failIfUnavailable: true });
  });

  it('fails the run with the reason when the sandbox is unavailable, and runs nothing (Behavior 5)', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    daemon.sdk.script({ sandboxUnavailable: 'sandbox unavailable: sandbox-exec is not permitted' });
    const runtime = daemon.app.get(AgentRuntime);
    const summary = await runtime.runFor(id, 'go', null, {}).finished;
    expect(summary).toMatchObject({ ok: false, failure: 'sandbox unavailable: sandbox-exec is not permitted' });
    expect(daemon.sdk.ran).toEqual([]);
  });

  it('signs gh in through GH_TOKEN, since the sandbox blocks the Keychain it keeps its token in (Behavior 9)', async () => {
    const daemon = await start();
    const github = CONNECTOR_SERVERS[ConnectorId.Github];
    await daemon.app
      .get<Keychain>(KEYCHAIN)
      .set(`mcp:${github?.name}`, JSON.stringify({ GITHUB_PERSONAL_ACCESS_TOKEN: 'gho_example' }));
    await converse(daemon, daemon.createSession(), 'go');
    expect(daemon.sdk.calls.at(-1)?.options.env?.GH_TOKEN).toBe('gho_example');
  });

  it('sets no GH_TOKEN while the GitHub Connector holds no token', async () => {
    const daemon = await start();
    await converse(daemon, daemon.createSession(), 'go');
    expect(daemon.sdk.calls.at(-1)?.options.env).not.toHaveProperty('GH_TOKEN');
  });

  it('sandboxes a Playbook step turn and the run after a failed one (Behavior 1, 7)', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    const steps = daemon.app.get(JobSteps);
    const job = { kind: 'reply_check', id: 'job-1' } as const;
    const store = daemon.app.get<Store>(STORE);
    store.db.run(sql`pragma foreign_keys = off`);
    store.write((tx) =>
      steps.seed(tx, job, [{ block: StepBlock.TraceLog, title: 'One', instructions: 'first', writes: false }]),
    );
    daemon.sdk.script({ crash: 'Claude Code died' });
    expect(await steps.run({ job, sessionId: id, brief: 'brief', rules: null })).toContain('failed');
    await converse(daemon, id, 'again');
    expect(daemon.sdk.calls).toHaveLength(2);
    for (const call of daemon.sdk.calls) expect(call.options.sandbox).toMatchObject({ enabled: true });
  });

  it('lets the run go on when a command is blocked (Behavior 8)', async () => {
    const daemon = await start();
    const id = daemon.createSession({ access_mode: AccessMode.Full });
    daemon.sdk.script(
      { tool: 'Bash', input: { command: 'cat runtime.json' }, fails: 'Operation not permitted' },
      { text: 'Tried another way.' },
    );
    await converse(daemon, id, 'go');
    expect((await api(daemon).get(`/sessions/${id}`)).body.data).toMatchObject({ state: 'idle', last_error: null });
  });

  it('shows why a run could not start in the Session (Behavior 5)', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    daemon.sdk.script({ sandboxUnavailable: 'sandbox unavailable: sandbox-exec is not permitted' });
    await converse(daemon, id, 'go');
    expect((await api(daemon).get(`/sessions/${id}`)).body.data).toMatchObject({
      state: 'failed',
      last_error: 'sandbox unavailable: sandbox-exec is not permitted',
    });
    await converse(daemon, id, 'again');
    expect((await api(daemon).get(`/sessions/${id}`)).body.data.last_error).toBeNull();
  });
});
