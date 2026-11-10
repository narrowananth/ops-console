import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessMode, ConnectorId, ErrorCode, HealthStatus } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_TOOLS_SERVER,
  OPEN_PULL_REQUEST_TOOL,
  RUN_INTEGRATION_TOOL,
  runOpenPullRequest,
} from '../src/agent/pull-request-tool';
import { AgentRuntime } from '../src/agent/runtime';
import { ApiError } from '../src/common/errors';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { connectors } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { ReposModule } from '../src/repos/repos.module';
import { PullRequestOpeningService } from '../src/workspace/pull-request-opening.service';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { type AgentDaemon, api, converse, startAgentDaemon, until } from './agent-fixtures';
import type { Step } from './fakes/agent-sdk';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeGitHost, hostPr } from './fakes/git-host';
import { FakeProbe } from './fakes/probe';
import { tempDir } from './helpers';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

const json = (body: object): Step => ({ text: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\`` });

type Ctx = {
  daemon: AgentDaemon;
  host: FakeGitHost;
  store: Store;
  http: ReturnType<typeof api>;
  repoId: string;
  dir: string;
  /** The bare repository `origin` points at. */
  remote: string;
};

/**
 * A daemon with GitHub connected, one imported Repo on GitHub to the console whose `origin` is a bare repository, and
 * a branch `work` with one commit `main` lacks.
 */
async function start(origin = 'git@github.com:acme/orders-api.git'): Promise<Ctx> {
  const host = new FakeGitHost();
  const daemon = await startAgentDaemon({
    fixtureKinds: false,
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console' }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      ReposModule.forRoot(),
      WorkspaceModule.forRoot({ hosts: host }),
    ],
  });
  running.push(daemon);
  const store = daemon.app.get<Store>(STORE);
  store.write((tx) => {
    tx.update(connectors)
      .set({ status: HealthStatus.Ok, login: 'octo-operator' })
      .where(eq(connectors.id, ConnectorId.Github))
      .run();
  });
  const dir = path.join(await tempDir('ops-console-git-'), 'orders-api');
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'remote', 'add', 'origin', origin);
  const http = api(daemon);
  const repoId = (await http.post('/repos', { path: dir })).body.data.id as string;
  // The Repo is on its Git host to the console; git reaches a bare repository.
  const remote = path.join(await tempDir('ops-console-origin-'), 'orders-api.git');
  git(path.dirname(remote), 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'remote', 'set-url', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'switch', '-q', '-c', 'work');
  await writeFile(path.join(dir, 'fix.txt'), 'fixed\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'Fix the total');
  // The Repo's own folder stays on main: Sessions work in worktrees of their own.
  git(dir, 'switch', '-q', 'main');
  return { daemon, host, store, http, repoId, dir, remote };
}

/** Where a Session's agent works. */
const worktree = (ctx: Ctx, sessionId: string) => path.join(ctx.daemon.dataDir, 'session-worktrees', sessionId);

const session = (ctx: Ctx, branch = 'work') =>
  ctx.http.post('/sessions', { repo_id: ctx.repoId, branch }).then((res) => res.body.data.id as string);

const BODY = { title: 'Fix the total', description: 'Defaults it to zero.', base_branch: 'main' };

describe('Pull request opening', () => {
  it('offers the button only for a branch with commits its base lacks and no open pull request (8)', async () => {
    const ctx = await start();
    const onMain = await session(ctx, 'main');
    expect((await ctx.http.get(`/sessions/${onMain}/pull-request`)).body.data).toMatchObject({ can_open: false });
    const id = await session(ctx);
    expect((await ctx.http.get(`/sessions/${id}/pull-request`)).body.data).toEqual({
      can_open: true,
      pull_request: null,
      base_branch: 'main',
      uncommitted_files: 0,
    });
    // Changes not committed are left out, and counted so the form can say so.
    await writeFile(path.join(worktree(ctx, id), 'draft.txt'), 'wip\n');
    expect((await ctx.http.get(`/sessions/${id}/pull-request`)).body.data.uncommitted_files).toBe(1);
  });

  it('shows no button for a Repo with no supported Git host, and refuses to open one (8)', async () => {
    const ctx = await start('ssh://git.example.com/orders-api.git');
    const id = await session(ctx);
    expect((await ctx.http.get(`/sessions/${id}/pull-request`)).body.data.can_open).toBe(false);
    const refused = await ctx.http.post(`/sessions/${id}/pull-request`, BODY);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('invalid_state');
  });

  it('has the agent draft the title and description and change nothing (9)', async () => {
    const ctx = await start();
    const id = await session(ctx);
    ctx.daemon.sdk.script(json({ title: 'Default the order total', description: 'Reads a missing total as zero.' }));
    const drafted = await ctx.http.post(`/sessions/${id}/pull-request-draft`, { base_branch: 'main' });
    expect(drafted.status).toBe(200);
    expect(drafted.body.data).toEqual({
      title: 'Default the order total',
      description: 'Reads a missing total as zero.',
    });
    const prompt = ctx.daemon.sdk.calls.at(-1)?.prompt ?? '';
    expect(prompt).toContain('git diff main...work');
    expect(prompt).toContain('Change nothing');
    expect(ctx.host.opened).toEqual([]);
  });

  it('gives empty fields when the draft turn does not answer as asked (9)', async () => {
    const ctx = await start();
    const id = await session(ctx);
    ctx.daemon.sdk.script({ text: 'I could not read the diff.' });
    const drafted = await ctx.http.post(`/sessions/${id}/pull-request-draft`, {});
    expect(drafted.body.data).toEqual({ title: null, description: null });
  });

  it('pushes the branch to origin and opens the pull request, with Action Log rows (1, 2, 11, 13)', async () => {
    const ctx = await start();
    const id = await session(ctx);
    const opened = await ctx.http.post(`/sessions/${id}/pull-request`, BODY);
    expect(opened.status).toBe(201);
    expect(opened.body.data).toEqual({ number: 41, url: 'https://github.com/acme/orders-api/pull/41' });
    expect(ctx.host.opened).toEqual([
      { title: 'Fix the total', body: 'Defaults it to zero.', head: 'work', base: 'main' },
    ]);
    expect(git(ctx.remote, 'rev-parse', 'work')).toBe(git(ctx.dir, 'rev-parse', 'work'));
    const log = (
      (await ctx.http.get('/action-log')).body.data as { kind: string; outcome: string; command: string }[]
    ).filter((row) => !row.command.includes('worktree add'));
    expect(log.map((row) => [row.kind, row.command, row.outcome]).sort()).toEqual([
      ['git', 'git push origin work', 'ok'],
      ['pr', 'open pull request work -> main', 'ok'],
    ]);
    // The header now shows the link in place of the button (11, 15).
    const after = await ctx.http.get(`/sessions/${id}/pull-request`);
    expect(after.body.data).toMatchObject({
      can_open: false,
      pull_request: { number: 41, url: 'https://github.com/acme/orders-api/pull/41' },
    });
    // The Session keeps the pull request it opened while it stays on that branch; another Session on the branch, or this
    // one on another branch, does not show it.
    const link = { number: 41, url: 'https://github.com/acme/orders-api/pull/41' };
    expect((await ctx.http.get(`/sessions/${id}`)).body.data.pull_request).toEqual(link);
    const beside = await session(ctx);
    expect((await ctx.http.get(`/sessions/${beside}`)).body.data.pull_request).toBeNull();
    await ctx.http.post(`/sessions/${id}/checkout`, { branch: 'next', create: true });
    expect((await ctx.http.get(`/sessions/${id}`)).body.data.pull_request).toBeNull();
    await ctx.http.post(`/sessions/${id}/checkout`, { branch: 'work' });
    expect((await ctx.http.get(`/sessions/${id}`)).body.data.pull_request).toEqual(link);
  });

  it('opens one pull request for two clicks at once, and shows the open one on a later click (14)', async () => {
    const ctx = await start();
    const id = await session(ctx);
    const [a, b] = await Promise.all([
      ctx.http.post(`/sessions/${id}/pull-request`, BODY),
      ctx.http.post(`/sessions/${id}/pull-request`, BODY),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.data).toEqual(b.body.data);
    const later = await ctx.http.post(`/sessions/${id}/pull-request`, BODY);
    expect(later.status).toBe(200);
    expect(later.body.data.number).toBe(41);
    expect(ctx.host.opened).toHaveLength(1);
  });

  it('returns the pull request already open for the branch and opens none (14, 18)', async () => {
    const ctx = await start();
    ctx.host.prs.push(hostPr(7, { branch: 'work' }));
    const id = await session(ctx);
    const res = await ctx.http.post(`/sessions/${id}/pull-request`, BODY);
    expect(res.status).toBe(200);
    expect(res.body.data.number).toBe(7);
    expect(ctx.host.opened).toEqual([]);
    // The header shows the link at once, not after the kept list expires.
    expect((await ctx.http.get(`/sessions/${id}/pull-request`)).body.data.pull_request).toMatchObject({ number: 7 });
  });

  it('refuses the default branch, a branch with no new commits and a base origin lacks', async () => {
    const ctx = await start();
    const onMain = await session(ctx, 'main');
    const main = await ctx.http.post(`/sessions/${onMain}/pull-request`, BODY);
    expect([main.status, main.body.error.code]).toEqual([409, 'invalid_state']);
    git(ctx.dir, 'branch', 'empty', 'main');
    const empty = await ctx.http.post(`/sessions/${await session(ctx, 'empty')}/pull-request`, BODY);
    expect([empty.status, empty.body.error.code]).toEqual([409, 'invalid_state']);
    const id = await session(ctx);
    const base = await ctx.http.post(`/sessions/${id}/pull-request`, { ...BODY, base_branch: 'no-such' });
    expect([base.status, base.body.error.code]).toEqual([400, 'validation_failed']);
    const blank = await ctx.http.post(`/sessions/${id}/pull-request`, { ...BODY, title: '  ' });
    expect([blank.status, blank.body.error.code]).toEqual([400, 'validation_failed']);
    expect(ctx.host.opened).toEqual([]);
  });

  it('pushes nothing and opens nothing when the Git host is not connected (6)', async () => {
    const ctx = await start();
    ctx.store.write((tx) => {
      tx.update(connectors).set({ status: HealthStatus.Off }).where(eq(connectors.id, ConnectorId.Github)).run();
    });
    const res = await ctx.http.post(`/sessions/${await session(ctx)}/pull-request`, BODY);
    expect([res.status, res.body.error.code]).toEqual([409, ErrorCode.ConnectorNotConnected]);
    expect(git(ctx.remote, 'branch', '--list', 'work')).toBe('');
    expect(ctx.host.opened).toEqual([]);
  });

  it('opens nothing when the branch moved on origin and the rebase conflicts, and says so (5)', async () => {
    const ctx = await start();
    const id = await session(ctx);
    const other = path.join(await tempDir('ops-console-other-'), 'clone');
    git(path.dirname(other), 'clone', '-q', ctx.remote, other);
    git(other, 'switch', '-q', '-c', 'work');
    await writeFile(path.join(other, 'fix.txt'), 'theirs\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'Their change');
    git(other, 'push', '-q', 'origin', 'work');
    const moved = await ctx.http.post(`/sessions/${id}/pull-request`, BODY);
    expect([moved.status, moved.body.error.code]).toEqual([409, ErrorCode.BranchMoved]);
    expect(moved.body.error.message).toMatch(
      /^Conflict: work moved on origin and rebasing onto it conflicts\. The rebase was aborted/,
    );
    // The branch is as it was: no rebase left half done.
    expect(git(worktree(ctx, id), 'status', '--porcelain', '--branch')).toBe('## work');
    expect(ctx.host.opened).toEqual([]);
    const log = (
      (await ctx.http.get('/action-log?kind=git')).body.data as { outcome: string; command: string }[]
    ).filter((row) => !row.command.includes('worktree add'));
    expect(log.map((row) => row.outcome)).toEqual(['failed']);
  });

  it('keeps the push when the host refuses, and a retry opens the pull request (6, 18)', async () => {
    const ctx = await start();
    const id = await session(ctx);
    ctx.host.failOpen = new ApiError(502, ErrorCode.UpstreamFailed, '`gh api POST` failed');
    const failed = await ctx.http.post(`/sessions/${id}/pull-request`, BODY);
    expect([failed.status, failed.body.error.code]).toEqual([502, 'upstream_failed']);
    expect(git(ctx.remote, 'rev-parse', 'work')).toBe(git(ctx.dir, 'rev-parse', 'work'));
    ctx.host.failOpen = null;
    const retried = await ctx.http.post(`/sessions/${id}/pull-request`, BODY);
    expect(retried.status).toBe(201);
    expect(ctx.host.opened).toHaveLength(1);
  });

  it('tells the agent to commit and ask through the console tool, never to push (1)', async () => {
    const ctx = await start();
    const id = await session(ctx);
    ctx.daemon.sdk.script({ text: 'ok' });
    await converse(ctx.daemon, id, 'create a pr now');
    const append = JSON.stringify(ctx.daemon.sdk.calls.at(-1)?.options.systemPrompt ?? '');
    expect(append).toContain('Never push a branch');
    expect(append).toContain(OPEN_PULL_REQUEST_TOOL);
    // Every run is told to work from the newest production branch, whichever Playbook it follows.
    expect(append).toContain('Latest code first');
    expect(append).toContain('git fetch origin');
  });

  it('gives the console tool to a Session in its Repo folder and to no other run (1)', async () => {
    const ctx = await start();
    ctx.daemon.sdk.script({ text: 'ok' }, { text: 'ok' }, { text: 'ok' });
    await converse(ctx.daemon, await session(ctx), 'hi');
    expect(Object.keys(ctx.daemon.sdk.calls.at(-1)?.options.mcpServers ?? {})).toEqual([CONSOLE_TOOLS_SERVER]);
    // An anonymous Session has no Repo to open a pull request in; it gets the tool that moves it into one instead.
    const anonymous = (await ctx.http.post('/sessions', { kind: 'anonymous' })).body.data.id as string;
    await converse(ctx.daemon, anonymous, 'hi');
    expect(Object.keys(ctx.daemon.sdk.calls.at(-1)?.options.mcpServers ?? {})).toEqual([CONSOLE_TOOLS_SERVER]);
    // A run in a scratch copy is not in the Repo's folder.
    const scratch = await tempDir('ops-console-scratch-');
    const runtime = ctx.daemon.app.get(AgentRuntime);
    await runtime.runFor(await session(ctx), 'hi', null, { cwd: scratch }).finished;
    expect(ctx.daemon.sdk.calls.at(-1)?.options.mcpServers).toBeUndefined();
  });

  describe('the agent runs an integration CLI', () => {
    const CALL = (cli: string, args: string[]) => ({ tool: RUN_INTEGRATION_TOOL, input: { cli, args } }) satisfies Step;

    it('runs a read at once in every Access mode, with no Approval', async () => {
      for (const mode of Object.values(AccessMode)) {
        const ctx = await start();
        const id = ctx.daemon.createSession({ access_mode: mode, repoId: ctx.repoId, branch: 'work' });
        ctx.daemon.sdk.script(CALL('gh', ['pr', 'view', '12']));
        await converse(ctx.daemon, id, 'look at pr 12');
        expect((await ctx.http.get('/approvals')).body.data, mode).toEqual([]);
        expect(ctx.daemon.sdk.ran, mode).toEqual(
          [CALL('gh', ['pr', 'view', '12'])].map((c) => ({ tool: c.tool, input: c.input })),
        );
      }
    });

    it('asks before a write, `full` included, and runs nothing on a no', async () => {
      const ctx = await start();
      const id = ctx.daemon.createSession({ access_mode: AccessMode.Full, repoId: ctx.repoId, branch: 'work' });
      ctx.daemon.sdk.script(CALL('gh', ['pr', 'comment', '12', '--body', 'hi']));
      await ctx.http.post(`/sessions/${id}/messages`, { text: 'comment on pr 12' });
      const [approval] = await until(
        async () => (await ctx.http.get('/approvals?status=pending')).body.data as { id: string; summary: string }[],
        (list) => list.length === 1,
        'the Approval',
      );
      expect(approval?.summary).toBe('Run outside the sandbox, as you: gh pr comment 12 --body hi');
      await ctx.http.post(`/approvals/${approval?.id}/decision`, { decision: 'denied' });
      await until(
        async () => (await ctx.http.get(`/sessions/${id}`)).body.data.state,
        (state) => state === 'idle',
        'the run to end',
      );
      expect(ctx.daemon.sdk.ran).toEqual([]);
    });

    it('refuses a merge and a sign-in with no Approval, and runs nothing', async () => {
      for (const [cli, args] of [
        ['gh', ['pr', 'merge', '12']],
        ['pup', ['auth', 'login']],
      ] as const) {
        const ctx = await start();
        const id = ctx.daemon.createSession({ access_mode: AccessMode.Full, repoId: ctx.repoId, branch: 'work' });
        ctx.daemon.sdk.script(CALL(cli, [...args]));
        await converse(ctx.daemon, id, 'do it');
        expect((await ctx.http.get('/approvals')).body.data).toEqual([]);
        expect(ctx.daemon.sdk.ran).toEqual([]);
      }
    });
  });

  describe('the agent asks for it', () => {
    const ASK: Step = {
      tool: OPEN_PULL_REQUEST_TOOL,
      input: { title: 'Fix the total', description: 'Defaults it to zero.' },
    };

    it('runs with no Approval in every Access mode, `full` included, and the console pushes and opens at once', async () => {
      for (const mode of Object.values(AccessMode)) {
        const ctx = await start();
        const id = ctx.daemon.createSession({ access_mode: mode, repoId: ctx.repoId, branch: 'work' });
        ctx.daemon.sdk.script(ASK);
        await converse(ctx.daemon, id, 'create a pr now');
        expect((await ctx.http.get('/approvals')).body.data, mode).toEqual([]);
        expect(ctx.daemon.sdk.ran, mode).toEqual([{ tool: OPEN_PULL_REQUEST_TOOL, input: ASK.input }]);
      }
    });

    it('rebases a branch that moved on origin onto it and pushes, never forced', async () => {
      const ctx = await start();
      const id = await session(ctx);
      // A teammate pushed a commit to `work` that the local branch lacks.
      const other = path.join(await tempDir('ops-console-clone-'), 'other');
      git(path.dirname(other), 'clone', '-q', ctx.remote, other);
      git(other, 'switch', '-q', '-c', 'work', 'origin/main');
      await writeFile(path.join(other, 'theirs.txt'), 'theirs\n');
      git(other, 'add', '.');
      git(other, 'commit', '-q', '-m', 'Their commit');
      git(other, 'push', '-q', 'origin', 'work');
      const answer = await runOpenPullRequest(ctx.daemon.app.get(PullRequestOpeningService), id, {
        title: 'Fix the total',
        description: 'Zero.',
      });
      expect(answer.isError).toBeUndefined();
      expect(git(ctx.remote, 'rev-parse', 'work')).toBe(git(ctx.dir, 'rev-parse', 'work'));
      expect(git(ctx.remote, 'log', '--format=%s', 'main..work')).toBe('Fix the total\nTheir commit');
    });

    it('is refused when nothing can open, and the agent is told why', async () => {
      const ctx = await start();
      git(ctx.dir, 'switch', '-q', 'main');
      const id = ctx.daemon.createSession({ access_mode: AccessMode.Full, repoId: ctx.repoId, branch: 'main' });
      ctx.daemon.sdk.script(ASK);
      await converse(ctx.daemon, id, 'create a pr now');
      expect((await ctx.http.get('/approvals')).body.data).toEqual([]);
      expect(ctx.daemon.sdk.ran).toEqual([]);
    });

    it('opens the branch checked out in the Repo folder, with the default base, and answers with the link', async () => {
      const ctx = await start();
      const id = await session(ctx);
      const opener = ctx.daemon.app.get(PullRequestOpeningService);
      const answer = await runOpenPullRequest(opener, id, { title: 'Fix the total', description: 'Zero.' });
      expect(answer).toEqual({
        content: [{ type: 'text', text: 'Opened pull request #41: https://github.com/acme/orders-api/pull/41' }],
      });
      expect(ctx.host.opened).toEqual([{ title: 'Fix the total', body: 'Zero.', head: 'work', base: 'main' }]);
      expect(git(ctx.remote, 'rev-parse', 'work')).toBe(git(ctx.dir, 'rev-parse', 'work'));
      // The branch the agent names wins over the one checked out.
      git(ctx.dir, 'branch', 'other', 'work');
      git(ctx.dir, 'switch', '-q', 'main');
      const named = await runOpenPullRequest(opener, id, { title: 'T', description: 'D', branch: 'other' });
      expect(named.content[0]?.text).toMatch(/^Opened pull request #\d+:/);
      expect(ctx.host.opened.at(-1)).toMatchObject({ head: 'other' });
    });

    it('tells the agent why when the host refuses, with isError set', async () => {
      const ctx = await start();
      ctx.host.failOpen = new ApiError(502, ErrorCode.UpstreamFailed, '`gh api POST` failed');
      const answer = await runOpenPullRequest(ctx.daemon.app.get(PullRequestOpeningService), await session(ctx), {
        title: 'T',
        description: 'D',
      });
      expect(answer).toEqual({
        content: [{ type: 'text', text: 'No pull request was opened: `gh api POST` failed' }],
        isError: true,
      });
    });
  });
});
