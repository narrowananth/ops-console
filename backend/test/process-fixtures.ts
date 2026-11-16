import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type SessionProcess, WS_PROTOCOL } from '@ops-console/shared';
import WebSocket from 'ws';
import { ProcessesModule } from '../src/processes/processes.module';
import { type AgentDaemon, api, startAgentDaemon, until } from './agent-fixtures';
import { tempDir } from './helpers';

export type Message = { type: string; [key: string]: unknown };

/** A small server: prints its port, echoes stdin lines as `got:<line>`, and starts a child that prints its pid. */
const SERVER = `
const http = require('node:http');
const { spawn } = require('node:child_process');
const host = process.argv[2] || '127.0.0.1';
const server = http.createServer((_req, res) => res.end('ok')).listen(0, host, () => {
  console.log('listening on ' + server.address().port);
});
if (process.argv[3] === 'child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  console.log('pids ' + process.pid + ' ' + child.pid);
}
process.stdin.on('data', (data) => console.log('got:' + String(data).trim()));
`;

/** A process that ignores SIGTERM and SIGHUP, so only SIGKILL ends it. */
const STUBBORN = `
process.on('SIGTERM', () => {});
process.on('SIGHUP', () => {});
console.log('stubborn ' + process.pid);
setInterval(() => {}, 1000);
`;

export type Fixtures = { server: string; stubborn: string };

export async function writeFixtures(): Promise<Fixtures> {
  const dir = await tempDir('ops-console-proc-');
  const server = path.join(dir, 'server.js');
  const stubborn = path.join(dir, 'stubborn.js');
  await writeFile(server, SERVER);
  await writeFile(stubborn, STUBBORN);
  return { server, stubborn };
}

/** A shell command that runs a script with this test's node, whatever the login shell's PATH holds. */
export const node = (file: string, ...args: string[]) =>
  [process.execPath, file, ...args].map((a) => `'${a}'`).join(' ');

export const startProcessDaemon = (dataDir?: string): Promise<AgentDaemon> =>
  startAgentDaemon({ modules: [ProcessesModule.forRoot()], ...(dataDir ? { dataDir } : {}) });

export async function startProcess(
  daemon: AgentDaemon,
  sessionId: string,
  body: { name: string; command?: string; script?: string; folder?: string },
): Promise<SessionProcess> {
  const response = await api(daemon).post(`/sessions/${sessionId}/processes`, body);
  if (response.status !== 201) throw new Error(`start failed: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.data;
}

export const listProcesses = async (daemon: AgentDaemon, sessionId: string): Promise<SessionProcess[]> =>
  (await api(daemon).get(`/sessions/${sessionId}/processes`)).body.data;

/** Waits for the process to reach `state`. */
export const reach = (daemon: AgentDaemon, sessionId: string, id: string, state: string) =>
  until(
    async () => (await listProcesses(daemon, sessionId)).find((p) => p.id === id),
    (found) => found?.state === state,
    `process to be ${state}`,
  );

export type Watch = { socket: WebSocket; messages: Message[]; output(): string; wait(text: string): Promise<string> };

/** A client of `/processes/:id`, as the dock holds one. */
export async function watch(daemon: AgentDaemon, id: string, token = daemon.token): Promise<Watch> {
  const socket = new WebSocket(`${daemon.url.replace('http', 'ws')}/processes/${id}`, [WS_PROTOCOL, token]);
  daemon.sockets.add(socket);
  const messages: Message[] = [];
  socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const output = () => messages.flatMap((m) => (m.type === 'output' ? [String(m.data)] : [])).join('');
  return {
    socket,
    messages,
    output,
    wait: (text) => until(output, (all) => all.includes(text), `"${text}" in the output`),
  };
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const gone = (...pids: number[]) =>
  until(
    () => pids.filter(alive),
    (left) => left.length === 0,
    `pids ${pids.join(', ')} to end`,
  );

/** The pids the server fixture printed: itself and its child. */
export const pidsIn = (text: string): [number, number] => {
  const match = /pids (\d+) (\d+)/.exec(text);
  if (!match) throw new Error(`no pids in ${text}`);
  return [Number(match[1]), Number(match[2])];
};

export const portIn = (text: string): number => {
  const match = /listening on (\d+)/.exec(text);
  if (!match) throw new Error(`no port in ${text}`);
  return Number(match[1]);
};
