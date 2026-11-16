import { type ChildProcess, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { GitHost, type LocalServer } from '@ops-console/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OutputFiles } from '../src/agent/output-files';
import { SessionsService } from '../src/agent/sessions.service';
import { repos } from '../src/db/schema';
import { STORE, type Store } from '../src/db/store';
import { type AgentDaemon, api, until, WORKING_DIR } from './agent-fixtures';
import { tempDir } from './helpers';
import {
  type Fixtures,
  node,
  portIn,
  startProcess,
  startProcessDaemon,
  watch,
  writeFixtures,
} from './process-fixtures';

const daemons: AgentDaemon[] = [];
const children: ChildProcess[] = [];
const sockets: Server[] = [];
let fixtures: Fixtures;
beforeAll(async () => {
  fixtures = await writeFixtures();
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const socket of sockets.splice(0)) socket.close();
  for (const daemon of daemons.splice(0)) await daemon.stop();
});
afterAll(() => {
  for (const child of children) child.kill('SIGKILL');
});

async function start() {
  const daemon = await startProcessDaemon();
  daemons.push(daemon);
  return { daemon, sessionId: daemon.createSession() };
}

/** A listening server of its own, outside the daemon, started in `cwd`. Returns its port. */
async function listenIn(cwd: string, host = '127.0.0.1'): Promise<number> {
  const child = spawn(process.execPath, [fixtures.server, host], { cwd });
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      if (text.includes('listening on')) resolve(portIn(text));
    });
  });
  return port;
}

const servers = async (daemon: AgentDaemon, sessionId: string): Promise<LocalServer[]> =>
  (await api(daemon).get(`/sessions/${sessionId}/local-servers`)).body.data.servers;

const waitForPort = (daemon: AgentDaemon, sessionId: string, port: number) =>
  until(
    async () => (await servers(daemon, sessionId)).find((server) => server.port === port),
    (found) => found !== undefined,
    `port ${port} in the list`,
  );

describe('local servers', () => {
  it('tags a server a Session process started with that process', async () => {
    const { daemon, sessionId } = await start();
    const started = await startProcess(daemon, sessionId, { name: 'api', command: node(fixtures.server) });
    const port = portIn(await (await watch(daemon, started.id)).wait('listening on'));

    const found = await waitForPort(daemon, sessionId, port);
    expect(found).toEqual({
      port,
      process: path.basename(process.execPath),
      folder: await realpath(WORKING_DIR),
      session_id: sessionId,
      process_id: started.id,
    });
  });

  it('tags a server by its folder when no Session process started it, and lists those first', async () => {
    const { daemon, sessionId } = await start();
    const outside = await listenIn(await tempDir('ops-console-outside-'));
    const inWorktree = await listenIn(WORKING_DIR);
    const inOutputs = await listenIn(daemon.app.get(OutputFiles).ensure(sessionId));
    const openedFolder = await tempDir('ops-console-opened-');
    const repoId = crypto.randomUUID();
    daemon.app.get<Store>(STORE).write((tx) => {
      tx.insert(repos)
        .values({
          id: repoId,
          name: 'opened',
          path: openedFolder,
          host: GitHost.Local,
          remoteSlug: null,
          defaultBranch: 'main',
        })
        .run();
    });
    daemon.app.get(SessionsService).write(sessionId, { extraRepoIds: JSON.stringify([repoId]) });
    const inOpened = await listenIn(openedFolder);

    await waitForPort(daemon, sessionId, outside);
    for (const port of [inWorktree, inOutputs, inOpened]) await waitForPort(daemon, sessionId, port);
    const listed = await servers(daemon, sessionId);

    const mine = [inWorktree, inOutputs, inOpened].sort((a, b) => a - b);
    expect(listed.filter((s) => s.session_id === sessionId).map((s) => s.port)).toEqual(expect.arrayContaining(mine));
    for (const server of listed.filter((s) => mine.includes(s.port))) expect(server.process_id).toBeNull();
    expect(listed.find((s) => s.port === outside)).toMatchObject({ session_id: null, process_id: null });
    const firstUntagged = listed.findIndex((s) => s.session_id === null);
    expect(listed.slice(firstUntagged).every((s) => s.session_id === null)).toBe(true);
    expect(listed.slice(0, firstUntagged).map((s) => s.port)).toEqual(
      listed
        .slice(0, firstUntagged)
        .map((s) => s.port)
        .sort((a, b) => a - b),
    );
  });

  it('tags a server by its process even from another folder, and only for that Session', async () => {
    const { daemon, sessionId } = await start();
    const other = daemon.createSession();
    // Its folder is in neither Session, so only the process ties it to `other`.
    const elsewhere = await tempDir('ops-console-elsewhere-');
    const started = await startProcess(daemon, other, {
      name: 'api',
      command: `cd '${elsewhere}' && '${process.execPath}' '${fixtures.server}'`,
    });
    const port = portIn(await (await watch(daemon, started.id)).wait('listening on'));

    const seen = await waitForPort(daemon, sessionId, port);
    expect(seen).toMatchObject({ session_id: null, process_id: null });
    expect(await waitForPort(daemon, other, port)).toMatchObject({ session_id: other, process_id: started.id });
  });

  it('leaves out a server that is not on loopback', async (ctx) => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((address) => address?.family === 'IPv4' && !address.internal)?.address;
    if (!lan) ctx.skip();
    const { daemon, sessionId } = await start();
    const loopback = await listenIn(WORKING_DIR);
    const onLan = await listenIn(WORKING_DIR, lan);

    await waitForPort(daemon, sessionId, loopback);
    expect((await servers(daemon, sessionId)).some((s) => s.port === onLan)).toBe(false);
  });

  it('leaves out the console’s own ports', async (ctx) => {
    const bound: number[] = [];
    for (const port of [4545, 4555, 4556]) {
      const socket = createServer();
      const ok = await new Promise<boolean>((resolve) => {
        socket.once('error', () => resolve(false));
        socket.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (ok) {
        sockets.push(socket);
        bound.push(port);
      }
    }
    if (bound.length === 0) ctx.skip();
    const { daemon, sessionId } = await start();
    const marker = await listenIn(WORKING_DIR);
    await waitForPort(daemon, sessionId, marker);
    expect((await servers(daemon, sessionId)).filter((s) => bound.includes(s.port))).toEqual([]);
  });
});
