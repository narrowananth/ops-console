import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConnectorId, FolderTarget, HealthStatus } from '@ops-console/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { connectors } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { ReposModule } from '../src/repos/repos.module';
import { WorkspaceModule } from '../src/workspace/workspace.module';
import { commitMessage } from '../src/workspace/workspace-sessions.service';
import { type AgentDaemon, api, startAgentDaemon } from './agent-fixtures';
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

/** A daemon with GitHub connected, a Repo whose `origin` is a bare repository, and a Session on branch `work`. */
async function start() {
  const opened: { dir: string; target: FolderTarget }[] = [];
  const daemon = await startAgentDaemon({
    fixtureKinds: false,
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console' }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      ReposModule.forRoot(),
      WorkspaceModule.forRoot({
        hosts: new FakeGitHost(),
        opener: async (dir, target) => void opened.push({ dir, target }),
      }),
    ],
  });
  running.push(daemon);
  daemon.app.get<Store>(STORE).write((tx) => {
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
  git(dir, 'remote', 'add', 'origin', 'git@github.com:acme/orders-api.git');
  const http = api(daemon);
  const repoId = (await http.post('/repos', { path: dir })).body.data.id as string;
  const remote = path.join(await tempDir('ops-console-origin-'), 'orders-api.git');
  git(path.dirname(remote), 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'remote', 'set-url', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'switch', '-q', '-c', 'work');
  await writeFile(path.join(dir, 'fix.txt'), 'fixed\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'Fix the total');
  git(dir, 'switch', '-q', 'main');
  const id = (await http.post('/sessions', { repo_id: repoId, branch: 'work' })).body.data.id as string;
  return { http, remote, opened, id, tree: path.join(daemon.dataDir, 'session-worktrees', id) };
}

describe('Commit, push and open folder', () => {
  it('commits every change with the operator’s message, or one written from the files', async () => {
    const ctx = await start();
    await writeFile(path.join(ctx.tree, 'a.txt'), 'a\n');
    const typed = await ctx.http.post(`/sessions/${ctx.id}/commit`, { message: 'Add a' });
    expect(typed.status).toBe(201);
    expect(typed.body.data).toMatchObject({ branch: 'work', message: 'Add a', files: 1 });
    expect(git(ctx.tree, 'log', '-1', '--format=%s')).toBe('Add a');

    await writeFile(path.join(ctx.tree, 'b.txt'), 'b\n');
    const blank = await ctx.http.post(`/sessions/${ctx.id}/commit`, {});
    expect(blank.body.data.message).toBe('Update b.txt');
    expect(git(ctx.tree, 'log', '-1', '--format=%s')).toBe('Update b.txt');
  });

  it('refuses a commit with nothing changed', async () => {
    const ctx = await start();
    const refused = await ctx.http.post(`/sessions/${ctx.id}/commit`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('invalid_state');
  });

  it('commits on a new branch the Session then follows', async () => {
    const ctx = await start();
    await writeFile(path.join(ctx.tree, 'c.txt'), 'c\n');
    const done = await ctx.http.post(`/sessions/${ctx.id}/commit`, { message: 'Add C', new_branch: true });
    expect(done.body.data.branch).toBe('ops/add-c');
    expect(git(ctx.tree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ops/add-c');
    const session = (await ctx.http.get(`/sessions/${ctx.id}`)).body.data;
    expect(session.branch).toBe('ops/add-c');
  });

  it('pushes the branch to origin without a pull request', async () => {
    const ctx = await start();
    await writeFile(path.join(ctx.tree, 'd.txt'), 'd\n');
    await ctx.http.post(`/sessions/${ctx.id}/commit`, { message: 'Add D' });
    const pushed = await ctx.http.post(`/sessions/${ctx.id}/push`, {});
    expect(pushed.status).toBe(200);
    expect(pushed.body.data).toEqual({ branch: 'work' });
    expect(git(ctx.remote, 'log', '-1', '--format=%s', 'work')).toBe('Add D');
  });

  it('opens the worktree in the editor or the file manager the daemon runs on', async () => {
    const ctx = await start();
    expect((await ctx.http.post(`/sessions/${ctx.id}/open-folder`, { target: 'editor' })).status).toBe(204);
    expect((await ctx.http.post(`/sessions/${ctx.id}/open-folder`, { target: 'folder' })).status).toBe(204);
    expect(ctx.opened).toEqual([
      { dir: ctx.tree, target: 'editor' },
      { dir: ctx.tree, target: 'folder' },
    ]);
    expect((await ctx.http.post(`/sessions/${ctx.id}/open-folder`, { target: 'rm' })).status).toBe(400);
  });

  it('writes a message from the file names', () => {
    expect(commitMessage([])).toBe('Update files');
    expect(commitMessage(['src/a.ts', 'b.ts'])).toBe('Update a.ts, b.ts');
    expect(commitMessage(['a', 'b', 'c', 'd', 'e'])).toBe('Update a, b, c and 2 more');
  });
});
