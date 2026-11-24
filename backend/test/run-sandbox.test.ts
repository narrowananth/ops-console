import { execFileSync } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccessMode, CONNECTOR_SERVERS, ConnectorId, GitHost, RunPurpose, StepBlock } from '@ops-console/shared';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { LINUX_RUN_SANDBOX_PENDING, runSandbox, worktreeGitDirs } from '../src/agent/run-sandbox';
import { AgentRuntime, HOST_WRITE_DENIALS } from '../src/agent/runtime';
import { repos } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { KEYCHAIN, type Keychain } from '../src/keychain/keychain';
import { JobSteps } from '../src/playbooks/job-steps';
import { type AgentDaemon, api, converse, startAgentDaemon, WORKING_DIR } from './agent-fixtures';
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

/** A git folder the console knows as a Repo, with `origin` at `origin` or none. */
async function addRepo(daemon: AgentDaemon, name: string, origin: string | null, removedAt: string | null = null) {
  const id = crypto.randomUUID();
  const dir = path.join(await tempDir('ops-console-remote-'), name);
  await mkdir(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
  daemon.app
    .get<Store>(STORE)
    .write((tx) =>
      tx.insert(repos).values({ id, name, path: dir, host: GitHost.Local, defaultBranch: 'main', removedAt }).run(),
    );
  return { id, dir };
}

const sandboxOf = (daemon: AgentDaemon, call = -1) => {
  const options = daemon.sdk.calls.at(call)?.options;
  if (!options?.sandbox) throw new Error('the run had no sandbox');
  return options.sandbox;
};

describe('Run sandbox on agent runs', () => {
  it('sandboxes a run in every Access mode, full included, and closes only the Keychain and what reaches it (Behavior 1, 2)', async () => {
    const daemon = await start();
    for (const mode of Object.values(AccessMode)) {
      const id = daemon.createSession({ access_mode: mode });
      await converse(daemon, id, 'go');
      expect(sandboxOf(daemon)).toMatchObject({ enabled: true, allowUnsandboxedCommands: false });
      // Commands write anywhere, reach any host and localhost, and use any Unix socket.
      expect(sandboxOf(daemon).network).toEqual({
        allowedDomains: ['*'],
        allowAllUnixSockets: true,
        allowLocalBinding: true,
      });
      expect(sandboxOf(daemon).filesystem?.allowWrite).toEqual(['/']);
      expect(sandboxOf(daemon).filesystem?.denyRead).toEqual([
        path.join(home, '.ops-console'),
        path.join(home, 'Library', 'Keychains'),
      ]);
      // The agent's own web tools are open too.
      expect(daemon.sdk.calls.at(-1)?.options.disallowedTools).not.toContain('WebFetch');
      expect(daemon.sdk.calls.at(-1)?.options.disallowedTools).not.toContain('WebSearch');
    }
    expect(daemon.sdk.calls).toHaveLength(Object.values(AccessMode).length);
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
    const job = { kind: 'report', id: 'job-1' } as const;
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

  it('tells the agent about the Repos the operator picked to the Session, and closes their git control files', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    const billing = await addRepo(daemon, 'billing', null);
    const orders = await addRepo(daemon, 'orders', null);
    expect((await api(daemon).patch(`/sessions/${id}`, { extra_repo_ids: [billing.id] })).body.data).toMatchObject({
      extra_repo_ids: [billing.id],
    });
    await converse(daemon, id, 'go');
    const { filesystem } = sandboxOf(daemon);
    expect(filesystem?.denyWrite).toEqual(
      expect.arrayContaining([path.join(billing.dir, '.git', 'hooks'), path.join(billing.dir, '.git', 'config')]),
    );
    const options = daemon.sdk.calls.at(-1)?.options;
    expect(options?.additionalDirectories).toContain(billing.dir);
    expect(options?.disallowedTools).toContain(`Edit(/${path.join(billing.dir, '.git', 'hooks')})`);
    expect(JSON.stringify(options?.systemPrompt)).toContain(billing.dir);
    // Repos picked later reach the next run only.
    await api(daemon).patch(`/sessions/${id}`, { extra_repo_ids: [billing.id, orders.id] });
    await converse(daemon, id, 'again');
    expect(sandboxOf(daemon).filesystem?.denyWrite).toEqual(
      expect.arrayContaining([path.join(orders.dir, '.git', 'hooks')]),
    );
  });

  it('refuses a Repo the console does not know or has removed, and keeps a repeated one once, and never lists the Session’s own Repo', async () => {
    const daemon = await start();
    const id = daemon.createSession();
    const billing = await addRepo(daemon, 'billing', null);
    const gone = await addRepo(daemon, 'gone', null, '2026-01-01T00:00:00.000Z');
    expect((await api(daemon).patch(`/sessions/${id}`, { extra_repo_ids: ['nope'] })).status).toBe(404);
    expect((await api(daemon).patch(`/sessions/${id}`, { extra_repo_ids: [gone.id] })).status).toBe(404);
    const kept = await api(daemon).patch(`/sessions/${id}`, { extra_repo_ids: [billing.id, billing.id] });
    expect(kept.body.data.extra_repo_ids).toEqual([billing.id]);
    const own = (await api(daemon).get(`/sessions/${id}`)).body.data.repo_id;
    const alone = await api(daemon).patch(`/sessions/${id}`, { extra_repo_ids: [own] });
    expect(alone.body.data.extra_repo_ids).toEqual([]);
    const cleared = await api(daemon).patch(`/sessions/${id}`, { extra_repo_ids: [] });
    expect(cleared.body.data.extra_repo_ids).toEqual([]);
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

describe('Run sandbox on Linux until it is verified there (Behavior 21)', () => {
  it('starts no run and shows the Session why', async () => {
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const daemon = await start();
      const id = daemon.createSession();
      await converse(daemon, id, 'go');
      expect((await api(daemon).get(`/sessions/${id}`)).body.data).toMatchObject({
        state: 'failed',
        last_error: LINUX_RUN_SANDBOX_PENDING,
      });
      expect(daemon.sdk.ran).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', { value: real });
    }
  });
});

describe('Run sandbox: what a run cannot change or read (ADR 0006)', () => {
  it('denies writes to the git control files the daemon’s git later reads, and the gitfile of a worktree', () => {
    const wd = '/work/repo';
    expect(runSandbox({ workingDir: wd }).filesystem?.denyWrite).toEqual([
      '/work/repo/.git/hooks',
      '/work/repo/.git/config',
      '/work/repo/.git/config.worktree',
      '/work/repo/.git/commondir',
      '/work/repo/.git/gitdir',
    ]);
    expect(runSandbox({ workingDir: wd, gitFile: true }).filesystem?.denyWrite).toEqual(['/work/repo/.git']);
  });

  it("closes a Session's own worktree's hooks, config and pointers, whose commits go into the Repo's git folder", async () => {
    const repo = await tempDir('ops-console-wt-');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync(
      'git',
      ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first'],
      {
        cwd: repo,
      },
    );
    const wd = path.join(await tempDir('ops-console-wt-data-'), 'wt');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wd], { cwd: repo });
    const dirs = worktreeGitDirs(wd);
    const common = await realpath(path.join(repo, '.git'));
    expect(dirs && (await realpath(dirs.common))).toBe(common);

    const fs = runSandbox({ workingDir: wd, gitFile: true, gitDirs: dirs }).filesystem;
    expect(fs?.denyWrite).toEqual(
      expect.arrayContaining([
        path.join(wd, '.git'),
        path.join(dirs?.common ?? '', 'hooks'),
        path.join(dirs?.common ?? '', 'config'),
        path.join(dirs?.admin ?? '', 'gitdir'),
        path.join(dirs?.admin ?? '', 'commondir'),
      ]),
    );
    expect(worktreeGitDirs(repo)).toBeNull();
  });

  it('denies reading the installed app and the login Keychain folder, and nothing else', () => {
    const fs = runSandbox({ workingDir: '/work/repo', home: '/home/op' }).filesystem;
    expect(fs?.denyRead).toEqual(['/home/op/.ops-console', '/home/op/Library/Keychains']);
  });

  it('closes the git control files of an extra Repo like the working folder', () => {
    const fs = runSandbox({
      workingDir: '/work/repo',
      repos: [
        { path: '/work/billing', gitFile: false },
        { path: '/work/wt', gitFile: true },
      ],
    }).filesystem;
    expect(fs?.denyWrite).toEqual(
      expect.arrayContaining(['/work/billing/.git/hooks', '/work/billing/.git/config', '/work/wt/.git']),
    );
  });

  it('closes the working folder and the Repo’s git folder to a read-only run', () => {
    const open = runSandbox({ workingDir: '/work/repo' });
    const readOnly = runSandbox({
      workingDir: '/work/repo',
      readOnly: true,
      gitDirs: { common: '/repo/.git', admin: '/repo/.git/worktrees/wt' },
    });
    expect(open.filesystem?.denyWrite).not.toContain('/work/repo');
    expect(readOnly.filesystem?.denyWrite).toEqual(expect.arrayContaining(['/work/repo', '/repo/.git']));
  });

  it('denies the file tools the Keychain folder, the installed app and the git control files, in every Access mode', async () => {
    const daemon = await start();
    for (const mode of Object.values(AccessMode)) {
      await converse(daemon, daemon.createSession({ access_mode: mode }), 'go');
      const denied = daemon.sdk.calls.at(-1)?.options.disallowedTools ?? [];
      expect(denied).toEqual(
        expect.arrayContaining([
          `Read(/${path.join(home, 'Library', 'Keychains', '**')})`,
          `Read(/${path.join(home, '.ops-console', '**')})`,
          `Edit(/${path.join(WORKING_DIR, '.git', 'config')})`,
          `Edit(/${path.join(WORKING_DIR, '.git', 'hooks')})`,
        ]),
      );
      // The credential folders and the data folder are no longer closed to the file tools.
      expect(denied).not.toContain(`Read(/${path.join(home, '.ssh', '**')})`);
      expect(denied).not.toContain(`Read(/${path.join(daemon.dataDir, 'runtime.json')})`);
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

  it('holds a Verification away from Git host writes and writable Connections', async () => {
    const daemon = await start();
    const runtime = daemon.app.get(AgentRuntime);
    await runtime.runFor(daemon.createSession(), 'verify', null, { purpose: RunPurpose.Verify }).finished;
    const verify = daemon.sdk.calls.at(-1)?.options.disallowedTools ?? [];
    expect(verify).toEqual(expect.arrayContaining(HOST_WRITE_DENIALS));
    await runtime.runFor(daemon.createSession(), 'chat', null, {}).finished;
    expect(daemon.sdk.calls.at(-1)?.options.disallowedTools).not.toContain('Bash(git push:*)');
  });

  it('makes a read-only run read-only: no edit tools and a closed working folder', async () => {
    const daemon = await start();
    const runtime = daemon.app.get(AgentRuntime);
    await runtime.runFor(daemon.createSession(), 'answer', null, { readOnly: true }).finished;
    const call = daemon.sdk.calls.at(-1);
    expect(call?.options.disallowedTools).toEqual(
      expect.arrayContaining(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']),
    );
    expect(call?.options.sandbox?.filesystem?.denyWrite).toContain(WORKING_DIR);
  });
});
