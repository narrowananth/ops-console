import { execFileSync } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccessMode, SessionKind } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { JOIN_REPO_TOOL, runJoinRepo } from '../src/agent/pull-request-tool';
import { AgentRuntime } from '../src/agent/runtime';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { ReposModule } from '../src/repos/repos.module';
import { matchRepos, RepoJoinService } from '../src/workspace/repo-join.service';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { type AgentDaemon, api, gate, startAgentDaemon, until } from './agent-fixtures';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeGitHost } from './fakes/git-host';
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

/** A daemon with one imported Repo, `orders-api`, on branch `work`. */
async function start() {
  const daemon = await startAgentDaemon({
    fixtureKinds: false,
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console' }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      ReposModule.forRoot(),
      WorkspaceModule.forRoot({ hosts: new FakeGitHost() }),
    ],
  });
  running.push(daemon);
  // The Repo's path is the real one: on macOS the temp folder sits behind a symlink.
  const dir = path.join(await realpath(await tempDir('ops-console-git-')), 'orders-api');
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/orders-api.git');
  git(dir, 'switch', '-q', '-c', 'work');
  const http = api(daemon);
  const repoId = (await http.post('/repos', { path: dir })).body.data.id as string;
  const anonymous = async (access_mode = AccessMode.Supervised) =>
    (await http.post('/sessions', { kind: 'anonymous', access_mode })).body.data.id as string;
  return { daemon, http, dir, repoId, anonymous };
}

const row = (id: string, name: string, over: Partial<{ path: string; remoteSlug: string | null }> = {}) => ({
  id,
  name,
  path: over.path ?? `/work/${name}`,
  remoteSlug: over.remoteSlug === undefined ? `acme/${name}` : over.remoteSlug,
  defaultBranch: 'main',
});

describe('matchRepos', () => {
  const rows = [row('a', 'orders-api'), row('b', 'web'), row('c', 'local-only', { remoteSlug: null })];

  it('finds a Repo by its name, ignoring case', () => {
    expect(matchRepos('Orders-API', rows).map((one) => one.id)).toEqual(['a']);
  });

  it('finds a Repo by its path, or a folder inside it', () => {
    expect(matchRepos('/work/web/', rows).map((one) => one.id)).toEqual(['b']);
    expect(matchRepos('/work/web/src/app', rows).map((one) => one.id)).toEqual(['b']);
  });

  it('finds a Repo by owner/name, an https URL or an ssh URL', () => {
    for (const query of [
      'acme/orders-api',
      'https://github.com/acme/orders-api',
      'https://github.com/acme/orders-api.git',
      'git@github.com:acme/orders-api.git',
    ]) {
      expect(matchRepos(query, rows).map((one) => one.id)).toEqual(['a']);
    }
  });

  it('finds a local Repo, which has no host, by name', () => {
    expect(matchRepos('local-only', rows).map((one) => one.id)).toEqual(['c']);
  });

  it('lets an exact path beat a name two Repos share, and reports two when only the name matches', () => {
    const twins = [row('x', 'app', { path: '/a/app' }), row('y', 'app', { path: '/b/app' })];
    expect(matchRepos('/b/app', twins).map((one) => one.id)).toEqual(['y']);
    expect(matchRepos('app', twins)).toHaveLength(2);
  });

  it('finds nothing for a name no Repo has, or an empty one', () => {
    expect(matchRepos('billing', rows)).toEqual([]);
    expect(matchRepos('  ', rows)).toEqual([]);
  });
});

describe('an Anonymous Session joins a Repo', () => {
  it('is offered the tool and told about Repos, in a run the operator started', async () => {
    const ctx = await start();
    const id = await ctx.anonymous();
    ctx.daemon.sdk.script({ text: 'ok' });
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'hi' });
    await until(
      () => ctx.daemon.sdk.calls.length,
      (count) => count === 1,
      'the run',
    );
    const call = ctx.daemon.sdk.calls[0];
    expect(Object.keys(call?.options.mcpServers ?? {})).toEqual(['ops-console']);
    expect(JSON.stringify(call?.options.systemPrompt)).toContain('call the join_repo tool first');
    await until(
      async () => (await ctx.http.get(`/sessions/${id}`)).body.data.state,
      (state) => state === 'idle',
      'the run to end',
    );
  });

  it('is not offered to a run the console starts', async () => {
    const ctx = await start();
    const id = await ctx.anonymous();
    const runtime = ctx.daemon.app.get(AgentRuntime);
    ctx.daemon.sdk.script({ text: 'ok' });
    await runtime.runFor(id, 'hi').finished;
    expect(ctx.daemon.sdk.calls.at(-1)?.options.mcpServers).toBeUndefined();
    expect(ctx.daemon.app.get(RepoJoinService).offers(id)).toBe(true);
  });

  it('asks first in every Access mode, and a yes moves the Session and starts the next turn in the Repo', async () => {
    for (const mode of Object.values(AccessMode)) {
      const ctx = await start();
      const id = await ctx.anonymous(mode);
      const hold = gate();
      ctx.daemon.sdk.script({ tool: JOIN_REPO_TOOL, input: { repo: 'orders-api' }, hold: hold.promise });
      await ctx.http.post(`/sessions/${id}/messages`, { text: 'fix the totals bug in orders-api' });
      const [approval] = await until(
        async () => (await ctx.http.get('/approvals?status=pending')).body.data as { id: string; summary: string }[],
        (list) => list.length === 1,
        `an Approval in ${mode}`,
      );
      expect(approval?.summary).toBe(
        `Move this Session into the Repo orders-api (${ctx.dir}): the agent then works in your checkout on its current branch`,
      );
      expect((await ctx.http.get(`/sessions/${id}`)).body.data.kind).toBe('anonymous');

      await ctx.http.post(`/approvals/${approval?.id}/decision`, { decision: 'approved' });
      // The tool runs in the daemon; the fake SDK does not run it, so the test calls it as the tool would.
      const answer = await runJoinRepo(ctx.daemon.app.get(RepoJoinService), id, { repo: 'orders-api' });
      expect(answer.content[0]?.text).toContain('now works in the Repo orders-api on branch work');
      hold.open();

      await until(
        () => ctx.daemon.sdk.calls.length,
        (count) => count === 2,
        'the next turn',
      );
      expect(ctx.daemon.sdk.calls[1]?.options.cwd).toBe(ctx.dir);
      expect(ctx.daemon.sdk.calls[1]?.prompt).toContain('You are now in the Repo');
      // The handover turn can branch, commit and ask for the pull request: the console tool is there, and it is told how.
      expect(ctx.daemon.sdk.calls[1]?.prompt).toContain('git switch -c');
      expect(ctx.daemon.sdk.calls[1]?.prompt).toContain('open_pull_request');
      expect(Object.keys(ctx.daemon.sdk.calls[1]?.options.mcpServers ?? {})).toEqual(['ops-console']);
      const session = (await ctx.http.get(`/sessions/${id}`)).body.data;
      expect(session).toMatchObject({ kind: SessionKind.Repo, repo_id: ctx.repoId, branch: 'work' });
    }
  });

  it('stays anonymous and starts nothing when the operator says no', async () => {
    const ctx = await start();
    const id = await ctx.anonymous();
    ctx.daemon.sdk.script({ tool: JOIN_REPO_TOOL, input: { repo: 'orders-api' } });
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'fix orders-api' });
    const [approval] = await until(
      async () => (await ctx.http.get('/approvals?status=pending')).body.data as { id: string }[],
      (list) => list.length === 1,
      'the Approval',
    );
    await ctx.http.post(`/approvals/${approval?.id}/decision`, { decision: 'denied' });
    await until(
      async () => (await ctx.http.get(`/sessions/${id}`)).body.data.state,
      (state) => state === 'idle',
      'the run to end',
    );
    expect(ctx.daemon.sdk.ran).toEqual([]);
    expect(ctx.daemon.sdk.calls).toHaveLength(1);
    expect((await ctx.http.get(`/sessions/${id}`)).body.data.kind).toBe('anonymous');
  });

  it('is refused before it asks when no imported Repo matches, and the agent is told what to do instead', async () => {
    const ctx = await start();
    const id = await ctx.anonymous();
    ctx.daemon.sdk.script({ tool: JOIN_REPO_TOOL, input: { repo: 'billing-service' } });
    await ctx.http.post(`/sessions/${id}/messages`, { text: 'fix billing-service' });
    await until(
      async () => (await ctx.http.get(`/sessions/${id}`)).body.data.state,
      (state) => state === 'idle',
      'the run to end',
    );
    expect((await ctx.http.get('/approvals')).body.data).toEqual([]);
    expect(ctx.daemon.sdk.ran).toEqual([]);
    expect((await ctx.http.get(`/sessions/${id}`)).body.data.kind).toBe('anonymous');
    const joiner = ctx.daemon.app.get(RepoJoinService);
    expect(() => joiner.describe(id, { repo: 'billing-service' })).toThrow(
      /no imported Repo matches "billing-service"/,
    );
    expect(() => joiner.describe(id, { repo: 'billing-service' })).toThrow(/Clone it into this folder/);
  });

  it('does not move a Session that is already in a Repo', async () => {
    const ctx = await start();
    const id = ctx.daemon.createSession({ repoId: ctx.repoId, branch: 'work' });
    const joiner = ctx.daemon.app.get(RepoJoinService);
    expect(joiner.offers(id)).toBe(false);
    expect(() => joiner.describe(id, { repo: 'orders-api' })).toThrow(/Only an Anonymous Session/);
  });
});
