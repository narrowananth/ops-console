import { type ChildProcess, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shellArgs } from '../src/processes/processes.service';
import { tempDir } from './helpers';
import { alive, gone } from './process-fixtures';

const hosts: ChildProcess[] = [];
const leftovers: number[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.kill('SIGKILL');
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
});

/**
 * A stand-in for the daemon: a process that holds a pty running `command` as a Session process does, and is then killed
 * without a chance to clean up. The shell and what it started must go with the terminal.
 */
async function killedHost(command: string, cached: boolean): Promise<{ pids: number[] }> {
  const dir = await tempDir('ops-console-hangup-');
  const worker = path.join(dir, 'worker.js');
  await writeFile(worker, 'console.log("pid " + process.pid); setInterval(() => {}, 1000);\n');
  const host = path.join(dir, 'host.cjs');
  await writeFile(
    host,
    `const pty = require(${JSON.stringify(require.resolve('node-pty'))});
const shell = process.env.SHELL || '/bin/zsh';
const term = pty.spawn(shell, ${JSON.stringify(shellArgs(command.replaceAll('WORKER', worker), cached ? {} : null))}, {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: ${JSON.stringify(dir)},
  env: { HOME: process.env.HOME, USER: process.env.USER, TERM: 'xterm-256color' },
});
let out = '';
term.onData((d) => { out += d; process.stdout.write(d); });
setInterval(() => {}, 1000);
`,
  );
  const child = spawn(process.execPath, [host], { stdio: ['ignore', 'pipe', 'ignore'] });
  hosts.push(child);
  let seen = '';
  child.stdout.on('data', (chunk) => {
    seen += String(chunk);
  });
  const want = command.split('WORKER').length - 1 || 1;
  const deadline = Date.now() + 15_000;
  while ((seen.match(/pid (\d+)/g) ?? []).length < want) {
    if (Date.now() > deadline) throw new Error(`workers did not start: ${seen}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const pids = [...seen.matchAll(/pid (\d+)/g)].map((m) => Number(m[1]));
  leftovers.push(...pids);
  child.kill('SIGKILL');
  return { pids };
}

describe.each([
  ['the login shell', false],
  ['the cached environment', true],
])('a Session process run with %s when the daemon is killed without cleanup', (_how, cached) => {
  it.each([
    ['a command', `'${process.execPath}' WORKER`],
    [
      'a command that starts a second one in the background',
      `'${process.execPath}' WORKER & '${process.execPath}' WORKER; wait`,
    ],
    ['a command run through another shell', `sh -c "'${process.execPath}' WORKER"`],
  ])('ends %s with the terminal', async (_name, command) => {
    const { pids } = await killedHost(command, cached);
    expect(pids.length).toBeGreaterThan(0);
    await gone(...pids);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });
});
