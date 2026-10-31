import { execFileSync } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { parseRemote } from '../src/repos/git';
import { ReposModule } from '../src/repos/repos.module';
import { type AgentDaemon, api, signIn, startAgentDaemon } from './agent-fixtures';
import { FakeFolderPicker } from './fakes/folder-picker';
import { FakeProbe } from './fakes/probe';
import { tempDir } from './helpers';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' });

/** A repository with one commit on `main`. */
async function makeRepo(name: string, origin?: string): Promise<string> {
  const dir = path.join(await tempDir('ops-console-git-'), name);
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return dir;
}

async function start() {
  const probe = new FakeProbe();
  const picker = new FakeFolderPicker();
  const daemon = await startAgentDaemon({
    modules: [McpServersModule.forRoot({ probe, launcher: '/opt/ops-console' }), ReposModule.forRoot({ picker })],
  });
  running.push(daemon);
  return { daemon, probe, picker };
}

type Repo = Record<string, unknown> & { id: string; name: string };

describe('the folder dialog', () => {
  it('answers the chosen folder without importing it, and null when the dialog is closed', async () => {
    const { daemon, picker } = await start();
    const dir = await makeRepo('orders-api', 'git@github.com:acme/orders-api.git');
    picker.next = dir;
    const chosen = await api(daemon).post('/repos/pick-folder');
    expect([chosen.status, chosen.body.data]).toEqual([200, { path: dir }]);
    expect((await api(daemon).get('/repos')).body.data).toEqual([]);
    picker.next = null;
    expect((await api(daemon).post('/repos/pick-folder')).body.data).toEqual({ path: null });
  });
});

describe('importing', () => {
  it('stores the top folder, names it after the folder and reads host, slug and branch from git', async () => {
    const { daemon } = await start();
    const dir = await makeRepo('orders-api', 'git@github.com:acme/orders-api.git');
    const imported = await api(daemon).post('/repos', { path: dir });
    expect(imported.status).toBe(201);
    expect(imported.body.data).toMatchObject({
      name: 'orders-api',
      host: 'github',
      remote_slug: 'acme/orders-api',
      default_branch: 'main',
      branch: 'main',
      dirty: false,
      missing: false,
    });
  });

  it('resolves a path inside the repository to its top folder, and expands ~', async () => {
    const { daemon } = await start();
    const dir = await makeRepo('web');
    await mkdir(path.join(dir, 'src', 'deep'), { recursive: true });
    const imported = await api(daemon).post('/repos', { path: path.join(dir, 'src', 'deep') });
    expect(imported.body.data.path).toMatch(/web$/);
    expect(imported.body.data.path).not.toContain('deep');

    const home = path.join(homedir(), '.ops-console-test-repo');
    await rm(home, { recursive: true, force: true });
    await mkdir(home, { recursive: true });
    try {
      git(home, 'init', '-q', '-b', 'main');
      const viaTilde = await api(daemon).post('/repos', { path: '~/.ops-console-test-repo' });
      expect(viaTilde.status).toBe(201);
      expect(viaTilde.body.data.path).toMatch(/\.ops-console-test-repo$/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('refuses a path that is not a repository, one that does not exist, and an empty one', async () => {
    const { daemon } = await start();
    const plain = await tempDir('ops-console-plain-');
    const notRepo = await api(daemon).post('/repos', { path: plain });
    expect(notRepo.status).toBe(400);
    expect(notRepo.body.error.code).toBe('not_a_repo');
    expect((await api(daemon).post('/repos', { path: '/no/such/folder' })).body.error.code).toBe('not_a_repo');
    expect((await api(daemon).post('/repos', { path: '  ' })).body.error.code).toBe('validation_failed');
  });

  it('refuses a top folder that is already imported', async () => {
    const { daemon } = await start();
    const dir = await makeRepo('api');
    await api(daemon).post('/repos', { path: dir });
    const again = await api(daemon).post('/repos', { path: dir });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('duplicate');
  });

  it('reads no origin or another host as local', async () => {
    const { daemon } = await start();
    const none = await api(daemon).post('/repos', { path: await makeRepo('no-remote') });
    expect(none.body.data).toMatchObject({ host: 'local', remote_slug: null });
    const other = await api(daemon).post('/repos', {
      path: await makeRepo('elsewhere', 'https://git.example.com/acme/x.git'),
    });
    expect(other.body.data).toMatchObject({ host: 'local', remote_slug: null });
  });

  it('takes the default branch from origin/HEAD, else the current branch', async () => {
    const { daemon } = await start();
    const dir = await makeRepo('has-head', 'git@gitlab.com:acme/has-head.git');
    git(dir, 'checkout', '-q', '-b', 'feature');
    git(dir, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    const withHead = await api(daemon).post('/repos', { path: dir });
    expect(withHead.body.data).toMatchObject({ host: 'gitlab', default_branch: 'develop', branch: 'feature' });
    const without = await makeRepo('no-head');
    git(without, 'checkout', '-q', '-b', 'trunk');
    expect((await api(daemon).post('/repos', { path: without })).body.data.default_branch).toBe('trunk');
  });
});

describe('listing', () => {
  it('returns Repos by name with branch and dirty state read from git each time', async () => {
    const { daemon } = await start();
    const b = await makeRepo('b-repo');
    const a = await makeRepo('a-repo');
    await api(daemon).post('/repos', { path: b });
    await api(daemon).post('/repos', { path: a });
    let list = (await api(daemon).get('/repos')).body.data as Repo[];
    expect(list.map((repo) => repo.name)).toEqual(['a-repo', 'b-repo']);

    git(a, 'checkout', '-q', '-b', 'topic');
    await writeFile(path.join(a, 'new.txt'), 'x');
    list = (await api(daemon).get('/repos')).body.data;
    expect(list[0]).toMatchObject({ name: 'a-repo', branch: 'topic', dirty: true });
    expect(list[1]).toMatchObject({ name: 'b-repo', branch: 'main', dirty: false });
  });

  it('shows a Repo whose folder is gone as missing with no branch, and keeps two with one name apart', async () => {
    const { daemon } = await start();
    const gone = await makeRepo('same');
    const other = await makeRepo('same');
    await api(daemon).post('/repos', { path: gone });
    await api(daemon).post('/repos', { path: other });
    await rename(gone, `${gone}-moved`);
    const list = (await api(daemon).get('/repos')).body.data as Repo[];
    expect(list).toHaveLength(2);
    expect(list.filter((repo) => repo.missing)).toHaveLength(1);
    expect(list.find((repo) => repo.missing)).toMatchObject({ branch: null, dirty: false });
  });
});

describe('renaming and removing', () => {
  it('renames the display name only, and removes the row but not the folder', async () => {
    const { daemon } = await start();
    const dir = await makeRepo('old-name');
    const { body } = await api(daemon).post('/repos', { path: dir });
    const renamed = await api(daemon).patch(`/repos/${body.data.id}`, { name: 'New name' });
    expect(renamed.body.data).toMatchObject({ name: 'New name', path: body.data.path });
    expect((await api(daemon).patch(`/repos/${body.data.id}`, { name: '' })).status).toBe(400);

    expect((await api(daemon).delete(`/repos/${body.data.id}`)).status).toBe(204);
    expect((await api(daemon).get('/repos')).body.data).toEqual([]);
    expect(execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel']).toString().trim()).toBeTruthy();
    expect((await api(daemon).delete(`/repos/${body.data.id}`)).status).toBe(404);
  });
});

describe('branches', () => {
  it('lists local branches by most recent commit with the current one marked', async () => {
    const { daemon } = await start();
    const dir = await makeRepo('branchy');
    const { body } = await api(daemon).post('/repos', { path: dir });
    git(dir, 'checkout', '-q', '-b', 'older');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'on older', '--date=2020-01-01T00:00:00');
    git(dir, 'checkout', '-q', 'main');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    git(dir, 'checkout', '-q', '-b', 'newer');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'on newer');
    const branches = await api(daemon).get(`/repos/${body.data.id}/branches`);
    expect(branches.body.data.map((branch: { name: string }) => branch.name)).toEqual(
      ['newer', 'main', 'older'].filter(Boolean),
    );
    expect(branches.body.data.find((branch: { current: boolean }) => branch.current).name).toBe('newer');
  });

  it('answers not_found when the folder is gone', async () => {
    const { daemon } = await start();
    const dir = await makeRepo('vanishing');
    const { body } = await api(daemon).post('/repos', { path: dir });
    await rm(dir, { recursive: true, force: true });
    expect((await api(daemon).get(`/repos/${body.data.id}/branches`)).status).toBe(404);
  });
});

describe('origin urls', () => {
  it.each([
    ['git@github.com:acme/api.git', 'github', 'acme/api'],
    ['https://github.com/acme/api', 'github', 'acme/api'],
    ['ssh://git@github.com/acme/api.git', 'github', 'acme/api'],
    ['https://user@bitbucket.org/acme/api.git', 'bitbucket', 'acme/api'],
    ['git@gitlab.com:group/sub/api.git', 'gitlab', 'group/sub/api'],
    ['https://git.example.com/acme/api.git', 'local', null],
    [null, 'local', null],
  ])('%s', (url, host, slug) => {
    expect(parseRemote(url)).toEqual({ host, slug });
  });
});

describe('project scope MCP servers', () => {
  it('lists the servers in a Repo .mcp.json with scope project, pending approval until Claude Code approves', async () => {
    const { daemon, probe } = await start();
    const dir = await makeRepo('with-mcp');
    await writeFile(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { docs: { type: 'stdio', command: 'node', args: ['docs.js'], env: {} } } }),
    );
    const repo = (await api(daemon).post('/repos', { path: dir })).body.data;
    const listed = (await api(daemon).get('/mcp-servers')).body.data.find((server: Repo) => server.name === 'docs');
    expect(listed).toMatchObject({
      scope: 'project',
      repo_id: repo.id,
      target: 'node docs.js',
      status: 'auth',
      status_detail: `operator@example.com: pending approval in Claude Code`,
    });
    probe.approve(daemon.home, 'docs');
    await api(daemon).post('/mcp-servers/docs/checks');
    expect(
      (await api(daemon).get('/mcp-servers')).body.data.find((server: Repo) => server.name === 'docs'),
    ).toMatchObject({
      status: 'ok',
    });
  });

  it('adds a project server to the Repo .mcp.json once, and removes it', async () => {
    const { daemon } = await start();
    const second = await api(daemon).post('/agent-accounts');
    await signIn(path.join(daemon.dataDir, 'accounts', second.body.data.account.id), 'second@example.com', 'pro');
    const dir = await makeRepo('write-mcp');
    const repo = (await api(daemon).post('/repos', { path: dir })).body.data;

    const missing = await api(daemon).post('/mcp-servers', {
      name: 'docs',
      transport: 'stdio',
      target: 'node docs.js',
      scope: 'project',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('validation_failed');

    const created = await api(daemon).post('/mcp-servers', {
      name: 'docs',
      transport: 'stdio',
      target: 'node docs.js',
      scope: 'project',
      repo_id: repo.id,
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ scope: 'project', repo_id: repo.id });
    const file = JSON.parse((await import('node:fs')).readFileSync(path.join(repo.path, '.mcp.json'), 'utf8'));
    expect(file.mcpServers.docs).toMatchObject({ command: 'node', args: ['docs.js'] });

    await api(daemon).delete('/mcp-servers/docs/credentials');
    const after = JSON.parse((await import('node:fs')).readFileSync(path.join(repo.path, '.mcp.json'), 'utf8'));
    expect(after.mcpServers.docs).toBeUndefined();
  });
});
