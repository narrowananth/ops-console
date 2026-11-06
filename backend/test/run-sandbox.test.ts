import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AccessMode,
  BUILT_IN_NETWORK_DOMAINS,
  CONNECTOR_SERVERS,
  ConnectorId,
  GitHost,
  StepBlock,
} from '@ops-console/shared';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { runSandbox } from '../src/agent/run-sandbox';
import { AgentRuntime } from '../src/agent/runtime';
import { repos } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { KEYCHAIN, type Keychain } from '../src/keychain/keychain';
import { JobSteps } from '../src/playbooks/job-steps';
import { type AgentDaemon, api, converse, startAgentDaemon, until, WORKING_DIR } from './agent-fixtures';
import { tempDir } from './helpers';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

async function start(dataDir?: string) {
  const daemon = await startAgentDaemon(dataDir ? { dataDir } : {});
  running.push(daemon);
  return daemon;
}

const home = os.homedir();
const BUILT_IN = [...BUILT_IN_NETWORK_DOMAINS];

/** A git folder the console knows as a Repo, with `origin` at `origin` or none. */
async function addRepo(daemon: AgentDaemon, name: string, origin: string | null, removedAt: string | null = null) {
  const dir = path.join(await tempDir('ops-console-remote-'), name);
  await mkdir(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
  daemon.app
    .get<Store>(STORE)
    .write((tx) =>
      tx
        .insert(repos)
        .values({ id: crypto.randomUUID(), name, path: dir, host: GitHost.Local, defaultBranch: 'main', removedAt })
        .run(),
    );
}

const sandboxOf = (daemon: AgentDaemon, call = -1) => {
  const options = daemon.sdk.calls.at(call)?.options;
  if (!options?.sandbox) throw new Error('the run had no sandbox');
  return options.sandbox;
};

describe('Run sandbox on agent runs', () => {
  it('sandboxes a run in every Access mode, full included (Behavior 1; Network Behavior 1, 3, 7)', async () => {
    const daemon = await start();
    for (const mode of Object.values(AccessMode)) {
      const id = daemon.createSession({ access_mode: mode });
      await converse(daemon, id, 'go');
      expect(sandboxOf(daemon)).toMatchObject({ enabled: true, allowUnsandboxedCommands: false });
      // The shell reaches the built-in hosts only, and the agent's own web tools, which the filter does not cover, are denied.
      expect(sandboxOf(daemon).network).toEqual({ allowedDomains: BUILT_IN, strictAllowlist: true });
      expect(daemon.sdk.calls.at(-1)?.options.disallowedTools).toEqual(
        expect.arrayContaining(['WebFetch', 'WebSearch']),
      );
    }
    expect(daemon.sdk.calls).toHaveLength(Object.values(AccessMode).length);
  });

  it('denies the data folder the daemon runs on and writes in the Session’s folder (Behavior 2, 3)', async () => {
    const daemon = await start();
    await converse(daemon, daemon.createSession(), 'go');
    const { filesystem } = sandboxOf(daemon);
    expect(filesystem?.allowWrite?.slice(0, 3)).toEqual([WORKING_DIR, '/tmp', '/private/tmp']);
    // Tool caches are writable so commit hooks and builds can fetch; a folder on PATH never is.
    expect(filesystem?.allowWrite).toEqual(
      expect.arrayContaining([
        path.join(home, '.cargo', 'registry'),
        path.join(home, 'go', 'pkg'),
        path.join(home, '.m2', 'repository'),
      ]),
    );
    expect(filesystem?.allowWrite).not.toContain(path.join(home, '.cargo', 'bin'));
    expect(filesystem?.allowWrite).not.toContain(path.join(home, 'go', 'bin'));
    expect(filesystem?.allowWrite).not.toContain(home);
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
    expect(writes.map((folders) => folders?.[0]).toSorted()).toEqual([a, b].toSorted());
    // The working folder is the only one that differs between the two.
    expect(writes[0]?.slice(1)).toEqual(writes[1]?.slice(1));
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

  it('adds the host of each Repo’s origin, in either form, and nothing for a Repo without one or with a remote that is no domain (Network Behavior 8)', async () => {
    const daemon = await start();
    await addRepo(daemon, 'billing', 'https://gitlab.example.com/acme/billing.git');
    await addRepo(daemon, 'orders', 'git@git.example.org:acme/orders.git');
    await addRepo(daemon, 'scratch', null);
    await addRepo(daemon, 'mirror', '/srv/git/mirror.git');
    await addRepo(daemon, 'odd', 'https://*/acme/odd.git');
    await addRepo(daemon, 'old', 'https://old.example.net/acme/old.git', '2026-01-01T00:00:00.000Z');
    await converse(daemon, daemon.createSession(), 'go');
    expect(sandboxOf(daemon).network?.allowedDomains?.toSorted()).toEqual(
      [...BUILT_IN, 'gitlab.example.com', 'git.example.org'].toSorted(),
    );
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

describe('Run sandbox: what a run cannot change or read (ADR 0006)', () => {
  it('denies writes to the git control files the daemon’s git later reads, and the gitfile of a worktree', () => {
    const wd = '/work/repo';
    expect(runSandbox({ workingDir: wd, dataDir: '/data', networkDomains: [] }).filesystem?.denyWrite).toEqual([
      '/work/repo/.git/hooks',
      '/work/repo/.git/config',
      '/work/repo/.git/config.worktree',
      '/work/repo/.git/commondir',
      '/work/repo/.git/gitdir',
    ]);
    expect(
      runSandbox({ workingDir: wd, dataDir: '/data', networkDomains: [], gitFile: true }).filesystem?.denyWrite,
    ).toEqual(['/work/repo/.git']);
  });

  it('lets a run write and read its output folder, and no other folder under the data folder', () => {
    const fs = runSandbox({
      workingDir: '/work/repo',
      dataDir: '/data',
      networkDomains: [],
      writable: ['/data/outputs/s1'],
    }).filesystem;
    expect(fs?.allowWrite).toContain('/data/outputs/s1');
    expect(fs?.allowRead).toContain('/data/outputs/s1');
    expect(fs?.allowWrite).not.toContain('/data');
    expect(fs?.denyRead).toContain('/data');
  });

  it('leaves the working folder out of the writable folders of a read-only run', () => {
    const open = runSandbox({ workingDir: '/work/repo', dataDir: '/data', networkDomains: [] });
    const readOnly = runSandbox({ workingDir: '/work/repo', dataDir: '/data', networkDomains: [], readOnly: true });
    expect(open.filesystem?.allowWrite).toContain('/work/repo');
    expect(readOnly.filesystem?.allowWrite).not.toContain('/work/repo');
    expect(readOnly.filesystem?.allowWrite).toEqual(expect.arrayContaining(['/tmp', '/private/tmp']));
    // It still reads its folder.
    expect(readOnly.filesystem?.allowRead).toContain('/work/repo');
  });

  it('denies the file tools the data folder’s secrets, the credential folders and the git control files, in every Access mode', async () => {
    const daemon = await start();
    for (const mode of Object.values(AccessMode)) {
      await converse(daemon, daemon.createSession({ access_mode: mode }), 'go');
      const denied = daemon.sdk.calls.at(-1)?.options.disallowedTools ?? [];
      const data = daemon.dataDir;
      expect(denied).toEqual(
        expect.arrayContaining([
          `Read(/${path.join(data, 'runtime.json')})`,
          `Edit(/${path.join(data, 'runtime.json')})`,
          `Read(/${path.join(data, 'accounts', '**')})`,
          `Read(/${path.join(home, '.ssh', '**')})`,
          `Read(/${path.join(home, '.aws', '**')})`,
          `Edit(/${path.join(WORKING_DIR, '.git', 'config')})`,
          `Edit(/${path.join(WORKING_DIR, '.git', 'hooks')})`,
        ]),
      );
      // The data folder is not denied as a whole: a scratch copy sits inside it and the run reads it.
      expect(denied).not.toContain(`Read(/${path.join(data, '**')})`);
    }
  });

  it('denies the hosts’ merge endpoints to every run, not only the merge commands', async () => {
    const daemon = await start();
    await converse(daemon, daemon.createSession(), 'go');
    const denied = daemon.sdk.calls.at(-1)?.options.disallowedTools ?? [];
    expect(denied).toEqual(
      expect.arrayContaining([
        'Bash(gh pr merge:*)',
        'Bash(*pulls/*/merge*)',
        'Bash(*merge_requests/*/merge*)',
        'Bash(*pullrequests/*/merge*)',
        'Bash(*mergePullRequest*)',
        'Bash(*enablePullRequestAutoMerge*)',
      ]),
    );
  });

  it('loads a Session’s own project settings, and a run in a folder that holds pull request code only the user’s', async () => {
    const daemon = await start();
    const runtime = daemon.app.get(AgentRuntime);
    await converse(daemon, daemon.createSession(), 'go');
    expect(daemon.sdk.calls.at(-1)?.options.settingSources).toBeUndefined();
    const id = daemon.createSession();
    await runtime.runFor(id, 'review', null, { projectSettings: false }).finished;
    expect(daemon.sdk.calls.at(-1)?.options.settingSources).toEqual(['user']);
  });

  it('makes a read-only run read-only: no edit tools and no writable working folder', async () => {
    const daemon = await start();
    const runtime = daemon.app.get(AgentRuntime);
    await runtime.runFor(daemon.createSession(), 'answer', null, { readOnly: true }).finished;
    const call = daemon.sdk.calls.at(-1);
    expect(call?.options.disallowedTools).toEqual(
      expect.arrayContaining(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']),
    );
    expect(call?.options.sandbox?.filesystem?.allowWrite).not.toContain(WORKING_DIR);
  });
});

describe('Network allowlist on Permissions', () => {
  const read = async (daemon: AgentDaemon) => (await api(daemon).get('/network-allowlist')).body.data;

  it('lists the three groups, with the Repo that has each host (Network Behavior 12)', async () => {
    const daemon = await start();
    expect(await read(daemon)).toEqual({ built_in: BUILT_IN, from_repos: [], added: [] });
    await addRepo(daemon, 'billing', 'https://gitlab.example.com/acme/billing.git');
    await addRepo(daemon, 'ledger', 'git@gitlab.example.com:acme/ledger.git');
    await addRepo(daemon, 'scratch', null);
    expect((await read(daemon)).from_repos).toEqual([{ domain: 'gitlab.example.com', repo: 'billing' }]);
  });

  it('saves a domain trimmed and lowercased, and the next run reaches it (Network Behavior 6, 10, 13)', async () => {
    const daemon = await start();
    const added = await api(daemon).post('/network-allowlist/domains', { domain: '  NPM.Example.com ' });
    expect(added.status).toBe(201);
    expect(added.body.data).toEqual({ domain: 'npm.example.com' });
    // A wildcard covers subdomains only, so the apex is its own entry.
    for (const domain of ['*.example.com', 'example.com']) {
      expect((await api(daemon).post('/network-allowlist/domains', { domain })).status).toBe(201);
    }
    expect((await read(daemon)).added).toEqual(['*.example.com', 'example.com', 'npm.example.com']);
    await converse(daemon, daemon.createSession(), 'go');
    expect(sandboxOf(daemon).network?.allowedDomains).toEqual([
      ...BUILT_IN,
      '*.example.com',
      'example.com',
      'npm.example.com',
    ]);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['*', 'a bare wildcard'],
    ['*.com', 'a wildcard over one label'],
    ['https://npm.example.com', 'a scheme'],
    ['npm.example.com/v1', 'a path'],
    ['npm.example.com:8080', 'a port'],
    ['npm example.com', 'a space'],
    ['npm.example.com.', 'a trailing dot'],
    ['10.0.0.1', 'an IP address'],
    [`${'a'.repeat(250)}.example.com`, 'a name over 253 characters'],
  ])('refuses %j (%s) and saves nothing (Network Behavior 14)', async (domain) => {
    const daemon = await start();
    const refused = await api(daemon).post('/network-allowlist/domains', { domain });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('validation_failed');
    expect(refused.body.error.message).toEqual(expect.any(String));
    expect((await read(daemon)).added).toEqual([]);
  });

  it('accepts a domain already on the list and changes nothing (Network Behavior 15)', async () => {
    const daemon = await start();
    await addRepo(daemon, 'billing', 'https://gitlab.example.com/acme/billing.git');
    await api(daemon).post('/network-allowlist/domains', { domain: 'npm.example.com' });
    for (const domain of ['github.com', 'gitlab.example.com', 'npm.example.com']) {
      const again = await api(daemon).post('/network-allowlist/domains', { domain });
      expect(again.status).toBe(200);
      expect(again.body.data).toEqual({ domain });
    }
    expect((await read(daemon)).added).toEqual(['npm.example.com']);
  });

  it('removes a domain from the next run and keeps it in a run that already started (Network Behavior 11, 16)', async () => {
    const daemon = await start();
    await api(daemon).post('/network-allowlist/domains', { domain: 'npm.example.com' });
    let release = () => {};
    daemon.sdk.script({ wait: new Promise((resolve) => (release = () => resolve(null))) });
    const running = daemon.app.get(AgentRuntime).runFor(daemon.createSession(), 'one', null, {});
    await until(
      () => daemon.sdk.calls.length,
      (calls) => calls === 1,
      'the first run to start',
    );

    expect((await api(daemon).delete('/network-allowlist/domains/npm.example.com')).status).toBe(204);
    await api(daemon).post('/network-allowlist/domains', { domain: 'pkg.example.com' });
    await converse(daemon, daemon.createSession(), 'two');
    release();
    await running.finished;

    const [first, second] = daemon.sdk.calls.map((call) => call.options.sandbox?.network?.allowedDomains);
    expect(first).toEqual([...BUILT_IN, 'npm.example.com']);
    expect(second).toEqual([...BUILT_IN, 'pkg.example.com']);
  });

  it('removes a domain by its name, wildcard or not and whatever the case (Network Behavior 16)', async () => {
    const daemon = await start();
    for (const domain of ['*.example.com', 'npm.example.com']) {
      await api(daemon).post('/network-allowlist/domains', { domain });
    }
    for (const name of ['*.example.com', 'NPM.Example.com']) {
      expect((await api(daemon).delete(`/network-allowlist/domains/${encodeURIComponent(name)}`)).status).toBe(204);
    }
    expect((await read(daemon)).added).toEqual([]);
  });

  it('answers 404 when the domain is not in Added by you (Network Behavior 16)', async () => {
    const daemon = await start();
    const missing = await api(daemon).delete('/network-allowlist/domains/github.com');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });

  it('builds a new list when a resumed conversation starts its next turn (Network Behavior 11)', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    await converse(daemon, id, 'first');
    await api(daemon).post('/network-allowlist/domains', { domain: 'npm.example.com' });
    await converse(daemon, id, 'second');
    expect(daemon.sdk.calls[1]?.options.resume).toBeTruthy();
    expect(daemon.sdk.calls.map((call) => call.options.sandbox?.network?.allowedDomains)).toEqual([
      BUILT_IN,
      [...BUILT_IN, 'npm.example.com'],
    ]);
  });

  it('keeps Added by you across a daemon restart, and a run after it has them (Network Behavior 11, 17)', async () => {
    const first = await start();
    await api(first).post('/network-allowlist/domains', { domain: 'npm.example.com' });
    const dataDir = first.dataDir;
    await running.pop()?.stop();
    const again = await start(dataDir);
    expect((await read(again)).added).toEqual(['npm.example.com']);
    await converse(again, again.createSession(), 'go');
    expect(sandboxOf(again).network?.allowedDomains).toContain('npm.example.com');
  });
});
