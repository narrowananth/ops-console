import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitHost, SessionKind, type WsEvent } from '@ops-console/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionsService } from '../src/agent/sessions.service';
import { repos } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { ProcessesService } from '../src/processes/processes.service';
import { type AgentDaemon, api, listen, until, WORKING_DIR } from './agent-fixtures';
import { tempDir } from './helpers';
import {
  alive,
  type Fixtures,
  gone,
  listProcesses,
  node,
  pidsIn,
  portIn,
  reach,
  startProcess,
  startProcessDaemon,
  watch,
  writeFixtures,
} from './process-fixtures';

const running: AgentDaemon[] = [];
let fixtures: Fixtures;
beforeAll(async () => {
  fixtures = await writeFixtures();
});
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});
afterAll(async () => {
  await rm(path.join(WORKING_DIR, 'package.json'), { force: true });
});

async function start() {
  const daemon = await startProcessDaemon();
  running.push(daemon);
  return { daemon, sessionId: daemon.createSession() };
}

describe('a Session process', () => {
  it('runs a server the operator can read from and type into, and keeps its output for the next viewer', async () => {
    const { daemon, sessionId } = await start();
    const started = await startProcess(daemon, sessionId, { name: 'api', command: node(fixtures.server) });
    expect(started).toMatchObject({ name: 'api', state: 'running', exit_code: null, started_by: 'operator' });
    expect(started.folder).toBe(WORKING_DIR);

    const first = await watch(daemon, started.id);
    await first.wait('listening on');
    first.socket.send('not json');
    first.socket.send(JSON.stringify({ type: 'resize', cols: 1, rows: 1 }));
    first.socket.send(JSON.stringify({ type: 'input', data: 'hello\n' }));
    await first.wait('got:hello');

    const late = await watch(daemon, started.id);
    await late.wait('got:hello');
    expect(late.messages[0]?.type).toBe('output');
    expect((await listProcesses(daemon, sessionId)).map((p) => p.state)).toEqual(['running']);
  });

  it('refuses a socket without the session token', async () => {
    const { daemon, sessionId } = await start();
    const started = await startProcess(daemon, sessionId, { name: 'api', command: 'sleep 30' });
    await expect(watch(daemon, started.id, 'wrong-token')).rejects.toThrow(/401/);
  });

  it('stops the server and what it started, and lists it as stopped', async () => {
    const { daemon, sessionId } = await start();
    const started = await startProcess(daemon, sessionId, {
      name: 'api',
      command: node(fixtures.server, '127.0.0.1', 'child'),
    });
    const view = await watch(daemon, started.id);
    const pids = pidsIn(await view.wait('pids '));
    expect(pids.every(alive)).toBe(true);

    const stopped = await api(daemon).post(`/processes/${started.id}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.data).toMatchObject({ state: 'stopped', exit_code: null });
    await gone(...pids);
  });

  it('ends a process that ignores the polite signals', async () => {
    const { daemon, sessionId } = await start();
    const started = await startProcess(daemon, sessionId, { name: 'stubborn', command: node(fixtures.stubborn) });
    const view = await watch(daemon, started.id);
    const pid = Number(/stubborn (\d+)/.exec(await view.wait('stubborn '))?.[1]);

    const stopped = await api(daemon).post(`/processes/${started.id}/stop`);
    expect(stopped.body.data.state).toBe('stopped');
    expect(alive(pid)).toBe(false);
  });

  it('shows a process that ends by itself as exited with its code, and its last output', async () => {
    const { daemon, sessionId } = await start();
    const started = await startProcess(daemon, sessionId, { name: 'job', command: 'echo finished-job; exit 3' });
    const exited = await reach(daemon, sessionId, started.id, 'exited');
    expect(exited?.exit_code).toBe(3);

    const view = await watch(daemon, started.id);
    await view.wait('finished-job');
    await until(
      () => view.messages,
      (all) => all.some((m) => m.type === 'exit'),
    );
    expect(view.messages.find((m) => m.type === 'exit')).toMatchObject({ code: 3 });
  });

  it('tells every open page as soon as a server it started listens', async () => {
    const { daemon, sessionId } = await start();
    const feed = await listen(daemon);
    const started = await startProcess(daemon, sessionId, {
      name: 'api',
      command: `sleep 1; ${node(fixtures.server)}`,
    });
    expect(started.state).toBe('running');
    const changes = () =>
      feed.events.filter((e) => e.event === 'browser.servers_changed' && e.data.session_id === sessionId).length;
    // The start announces once; the scan that follows finds the listener and announces again, with no browser asking.
    await until(changes, (count) => count >= 2, 'the servers event for the listener');
    feed.close();
  });

  it('tells every open page when a process starts and when it ends', async () => {
    const { daemon, sessionId } = await start();
    const feed = await listen(daemon);
    const started = await startProcess(daemon, sessionId, { name: 'job', command: 'exit 0' });
    const states = () =>
      feed.events.flatMap((e: WsEvent) => (e.event === 'process.changed' ? [e.data.process.state] : []));
    await until(states, (all) => all.some((state) => state === 'exited'), 'the exit event');
    expect(states()[0]).toBe('running');
    expect(feed.events.some((e) => e.event === 'browser.servers_changed' && e.data.session_id === sessionId)).toBe(
      true,
    );

    await api(daemon).delete(`/processes/${started.id}`);
    await until(
      () => feed.events,
      (all) => all.some((e) => e.event === 'process.removed' && e.data.process_id === started.id),
    );
    feed.close();
  });

  it('restarts the same command in the same row', async () => {
    const { daemon, sessionId } = await start();
    const started = await startProcess(daemon, sessionId, {
      name: 'api',
      command: node(fixtures.server, '127.0.0.1', 'child'),
    });
    const before = pidsIn(await (await watch(daemon, started.id)).wait('pids '));

    const restarted = await api(daemon).post(`/processes/${started.id}/restart`);
    expect(restarted.body.data).toMatchObject({ id: started.id, state: 'running', command: started.command });
    await gone(...before);
    const after = pidsIn(await (await watch(daemon, started.id)).wait('pids '));
    expect(after[0]).not.toBe(before[0]);
    expect(await listProcesses(daemon, sessionId)).toHaveLength(1);
  });

  it('deletes a process, stopping it first when it runs', async () => {
    const { daemon, sessionId } = await start();
    const started = await startProcess(daemon, sessionId, {
      name: 'api',
      command: node(fixtures.server, '127.0.0.1', 'child'),
    });
    const pids = pidsIn(await (await watch(daemon, started.id)).wait('pids '));

    expect((await api(daemon).delete(`/processes/${started.id}`)).status).toBe(204);
    await gone(...pids);
    expect(await listProcesses(daemon, sessionId)).toEqual([]);
    expect((await api(daemon).post(`/processes/${started.id}/stop`)).status).toBe(404);
  });

  it('names a second process like the first with a number', async () => {
    const { daemon, sessionId } = await start();
    await startProcess(daemon, sessionId, { name: 'dev', command: 'exit 0' });
    await startProcess(daemon, sessionId, { name: 'dev', command: 'exit 0' });
    const third = await startProcess(daemon, sessionId, { name: 'dev', command: 'exit 0' });
    expect(third.name).toBe('dev-3');
    expect((await listProcesses(daemon, sessionId)).map((p) => p.name)).toEqual(['dev', 'dev-2', 'dev-3']);
  });

  it('opens a shell for a new terminal the operator types in', async () => {
    const { daemon, sessionId } = await start();
    const started = await startProcess(daemon, sessionId, { name: 'shell' });
    expect(started.command).toBe('');
    const view = await watch(daemon, started.id);
    view.socket.send(JSON.stringify({ type: 'input', data: 'echo typed-$((40 + 2))\n' }));
    await view.wait('typed-42');
  });
});

describe('what a process runs with', () => {
  it('gets the operator’s login environment and nothing of the daemon’s own', async () => {
    const { daemon, sessionId } = await start();
    const saved = { token: process.env.OPS_CONSOLE_TOKEN, claude: process.env.CLAUDE_CONFIG_DIR };
    process.env.OPS_CONSOLE_TOKEN = 'sentinel-session-token';
    process.env.CLAUDE_CONFIG_DIR = '/sentinel/claude';
    try {
      const started = await startProcess(daemon, sessionId, { name: 'env', command: 'env; echo env-done' });
      const view = await watch(daemon, started.id);
      const all = await view.wait('env-done');
      expect(all).toContain(`HOME=${process.env.HOME}`);
      expect(all).toMatch(/PATH=/);
      expect(all).not.toContain('OPS_CONSOLE');
      expect(all).not.toContain('sentinel');
    } finally {
      if (saved.token === undefined) delete process.env.OPS_CONSOLE_TOKEN;
      else process.env.OPS_CONSOLE_TOKEN = saved.token;
      if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved.claude;
    }
  });

  it('runs in the Session’s working folder, or in an Opened Repo’s, and nowhere else', async () => {
    const { daemon, sessionId } = await start();
    const here = await startProcess(daemon, sessionId, { name: 'here', command: 'pwd -P; echo pwd-done' });
    const view = await watch(daemon, here.id);
    expect(await view.wait('pwd-done')).toContain(path.basename(WORKING_DIR));

    const opened = await tempDir('ops-console-opened-');
    const repoId = crypto.randomUUID();
    daemon.app.get<Store>(STORE).write((tx) => {
      tx.insert(repos)
        .values({
          id: repoId,
          name: 'opened',
          path: opened,
          host: GitHost.Local,
          remoteSlug: null,
          defaultBranch: 'main',
        })
        .run();
    });
    daemon.app.get(SessionsService).write(sessionId, { extraRepoIds: JSON.stringify([repoId]) });
    const there = await startProcess(daemon, sessionId, {
      name: 'there',
      command: 'pwd -P; echo pwd-done',
      folder: opened,
    });
    expect(there.folder).toBe(opened);
    expect(await (await watch(daemon, there.id)).wait('pwd-done')).toContain(path.basename(opened));

    const elsewhere = await tempDir('ops-console-elsewhere-');
    const refused = await api(daemon).post(`/sessions/${sessionId}/processes`, {
      name: 'x',
      command: 'ls',
      folder: elsewhere,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('validation_failed');
    expect(await listProcesses(daemon, sessionId)).toHaveLength(2);
  });

  it('is offered to repo and anonymous Sessions only', async () => {
    const { daemon, sessionId } = await start();
    const review = daemon.createSession({ kind: SessionKind.PrReview });
    const blocked = await api(daemon).post(`/sessions/${review}/processes`, { name: 'x', command: 'ls' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('browser_not_available');
    expect((await api(daemon).get(`/sessions/${review}/scripts`)).status).toBe(409);
    expect((await api(daemon).get('/sessions/nope/processes')).status).toBe(404);
    const service = daemon.app.get(ProcessesService);
    expect([service.offers(sessionId), service.offers(review), service.offers('nope')]).toEqual([true, false, false]);
  });
});

describe('starting a package script', () => {
  const lockfiles = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json'];
  afterEach(async () => {
    for (const file of lockfiles) await rm(path.join(WORKING_DIR, file), { force: true });
  });

  const writePackage = (scripts: Record<string, string>) =>
    writeFile(path.join(WORKING_DIR, 'package.json'), JSON.stringify({ name: 'fixture', scripts }));

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ])('with %s runs the script through %s', async (lockfile, runner) => {
    const { daemon, sessionId } = await start();
    await writePackage({ dev: 'vite', test: 'vitest' });
    await writeFile(path.join(WORKING_DIR, lockfile), '');

    const scripts = await api(daemon).get(`/sessions/${sessionId}/scripts`);
    expect(scripts.body.data).toEqual({
      scripts: [
        { id: 'package.json:dev', source: 'package.json', name: 'dev', run: `${runner} run dev`, command: 'vite' },
        { id: 'package.json:test', source: 'package.json', name: 'test', run: `${runner} run test`, command: 'vitest' },
      ],
    });
    const started = await startProcess(daemon, sessionId, { name: 'dev', script: 'package.json:dev' });
    expect(started.command).toBe(`${runner} run dev`);
  });

  it('lists none for a folder without a package.json, and runs only a script that is in it', async () => {
    const { daemon, sessionId } = await start();
    await rm(path.join(WORKING_DIR, 'package.json'), { force: true });
    expect((await api(daemon).get(`/sessions/${sessionId}/scripts`)).body.data).toEqual({ scripts: [] });

    await writePackage({ dev: 'vite' });
    const missing = await api(daemon).post(`/sessions/${sessionId}/processes`, {
      name: 'x',
      script: 'package.json:deploy',
    });
    expect(missing.status).toBe(422);
    const both = await api(daemon).post(`/sessions/${sessionId}/processes`, {
      name: 'x',
      script: 'package.json:dev',
      command: 'ls',
    });
    expect(both.status).toBe(400);
    expect(await listProcesses(daemon, sessionId)).toEqual([]);
  });

  it('quotes a script name so the shell reads it as one word', async () => {
    const { daemon, sessionId } = await start();
    await writePackage({ 'a b; echo injected': 'true' });
    const started = await startProcess(daemon, sessionId, { name: 'odd', script: 'package.json:a b; echo injected' });
    expect(started.command).toBe("npm run 'a b; echo injected'");
    const view = await watch(daemon, started.id);
    await reach(daemon, sessionId, started.id, 'exited');
    expect(view.output()).not.toMatch(/^injected/m);
  });
});

describe('scripts of any kind of project', () => {
  const files = [
    'Makefile',
    'justfile',
    'Cargo.toml',
    'go.mod',
    'pom.xml',
    'compose.yaml',
    'manage.py',
    'package.json',
  ];
  // A package.json an earlier test left would list its scripts too.
  const clear = async () => {
    for (const file of files) await rm(path.join(WORKING_DIR, file), { force: true });
  };
  beforeEach(clear);
  afterEach(clear);

  it('lists make targets and just recipes with their first line, and runs one through its tool', async () => {
    const { daemon, sessionId } = await start();
    await writeFile(
      path.join(WORKING_DIR, 'Makefile'),
      [
        'CC := gcc',
        '.PHONY: build test',
        'build: deps',
        '\techo building',
        'test lint:',
        '\techo testing',
        '%.o: %.c',
        '\t$(CC) -c $<',
        'URL = http://example.com',
      ].join('\n'),
    );
    await writeFile(
      path.join(WORKING_DIR, 'justfile'),
      'set shell := ["bash", "-c"]\ndev port="80":\n  echo dev\n_hidden:\n  true\n',
    );
    const { scripts } = (await api(daemon).get(`/sessions/${sessionId}/scripts`)).body.data;
    expect(scripts).toEqual([
      { id: 'Makefile:build', source: 'Makefile', name: 'build', run: 'make build', command: 'echo building' },
      { id: 'Makefile:test', source: 'Makefile', name: 'test', run: 'make test', command: 'echo testing' },
      { id: 'Makefile:lint', source: 'Makefile', name: 'lint', run: 'make lint', command: 'echo testing' },
      { id: 'justfile:dev', source: 'justfile', name: 'dev', run: 'just dev', command: 'echo dev' },
    ]);
    const started = await startProcess(daemon, sessionId, { name: 'build', script: 'Makefile:build' });
    expect(started.command).toBe('make build');
  });

  it('lists the usual commands of a Cargo, Go, Maven or Docker Compose folder', async () => {
    const { daemon, sessionId } = await start();
    for (const file of ['Cargo.toml', 'go.mod', 'pom.xml', 'compose.yaml'])
      await writeFile(path.join(WORKING_DIR, file), '');
    const { scripts } = (await api(daemon).get(`/sessions/${sessionId}/scripts`)).body.data as {
      scripts: { source: string; run: string }[];
    };
    const runs = (source: string) => scripts.filter((one) => one.source === source).map((one) => one.run);
    expect(runs('Cargo')).toContain('cargo test');
    expect(runs('Go')).toContain('go test ./...');
    expect(runs('Maven')).toContain('mvn test');
    expect(runs('Docker Compose')).toContain('docker compose up');
  });
});

describe('the agent’s start_process', () => {
  it('describes the exact command, the folder and where it runs, before anything starts', async () => {
    const { daemon, sessionId } = await start();
    const service = daemon.app.get(ProcessesService);
    const described = await service.describeStart(sessionId, { name: 'web', command: 'pnpm dev --port 5173' });
    expect(described.folder).toBe(WORKING_DIR);
    expect(described.summary).toContain('pnpm dev --port 5173');
    expect(described.summary).toContain(WORKING_DIR);
    expect(described.summary).toContain("Runs as you, outside the sandbox, with this Repo's environment.");
    await expect(service.describeStart(sessionId, { name: 'web', command: 'ls', folder: '/' })).rejects.toThrow(
      /working folder/,
    );
    expect(await listProcesses(daemon, sessionId)).toEqual([]);
  });

  it('starts, reads the last lines without colour codes, and stops a process by name', async () => {
    const { daemon, sessionId } = await start();
    const service = daemon.app.get(ProcessesService);
    const started = await service.startForAgent(sessionId, {
      name: 'web',
      command: `printf '\\033[32mline-one\\033[0m\\nline-two\\nline-three\\n'; ${node(fixtures.server)}`,
    });
    expect(started.started_by).toBe('agent');
    await until(
      () => service.outputOf(sessionId, 'web', 500),
      (text) => text.includes('listening on'),
      'the server output',
    );

    expect(service.outputOf(sessionId, 'web', 500)).toContain('line-one\nline-two\nline-three');
    expect(service.outputOf(sessionId, 'web', 500)).not.toContain('\u001b');
    expect(service.outputOf(sessionId, 'web', 1).trim()).toMatch(/^listening on \d+$/);
    expect(() => service.outputOf(sessionId, 'nope', 5)).toThrow(/no process named nope/);

    expect((await service.stopByName(sessionId, 'web')).state).toBe('stopped');
    expect(service.list(sessionId).map((p) => [p.name, p.state])).toEqual([['web', 'stopped']]);
  });
});

describe('when processes end', () => {
  it('deleting the Session stops its processes and what they started', async () => {
    const { daemon, sessionId } = await start();
    const started = await startProcess(daemon, sessionId, {
      name: 'api',
      command: node(fixtures.server, '127.0.0.1', 'child'),
    });
    const pids = pidsIn(await (await watch(daemon, started.id)).wait('pids '));

    expect((await api(daemon).delete(`/sessions/${sessionId}`)).status).toBe(204);
    await gone(...pids);
    expect((await api(daemon).post(`/processes/${started.id}/stop`)).status).toBe(404);
  });

  it('a daemon exit stops every process, and the next start lists the rows as stopped', async () => {
    const dataDir = await tempDir();
    const first = await startProcessDaemon(dataDir);
    const sessionId = first.createSession();
    const one = await startProcess(first, sessionId, {
      name: 'api',
      command: node(fixtures.server, '127.0.0.1', 'child'),
    });
    await startProcess(first, sessionId, { name: 'job', command: 'exit 4' });
    const pids = pidsIn(await (await watch(first, one.id)).wait('pids '));
    await first.stop();
    await gone(...pids);

    const second = await startProcessDaemon(dataDir);
    running.push(second);
    const listed = await listProcesses(second, sessionId);
    expect(listed.map((p) => [p.name, p.state, p.exit_code])).toEqual([
      ['api', 'stopped', null],
      ['job', 'stopped', null],
    ]);

    const restarted = await api(second).post(`/processes/${one.id}/restart`);
    expect(restarted.body.data.state).toBe('running');
    expect(portIn(await (await watch(second, one.id)).wait('listening on'))).toBeGreaterThan(0);
  });
});
