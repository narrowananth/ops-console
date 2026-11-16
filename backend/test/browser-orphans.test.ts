import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserModule } from '../src/browser/browser.module';
import { type AgentDaemon, startAgentDaemon, until } from './agent-fixtures';
import { tempDir } from './helpers';

const running: AgentDaemon[] = [];
const decoys: number[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const pid of decoys.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A process whose command line names a Chrome profile folder, as a Chrome left behind by a killed daemon does. */
async function decoy(profile: string): Promise<number> {
  const script = path.join(await tempDir('ops-console-decoy-'), 'chrome.js');
  await writeFile(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script, `--user-data-dir=${profile}`], { stdio: 'ignore', detached: true });
  child.unref();
  const pid = child.pid ?? 0;
  decoys.push(pid);
  await until(
    () => alive(pid),
    (up) => up,
    'the decoy to run',
  );
  return pid;
}

describe('a Chrome left behind by a daemon that was killed', () => {
  it('is ended when the next daemon starts on the same data folder, and nothing else is', async () => {
    const dataDir = await tempDir('ops-console-data-');
    const stray = await decoy(path.join(dataDir, 'browser', 'session-1'));
    const other = await decoy(path.join(await tempDir('ops-console-other-'), 'browser', 'session-2'));
    running.push(await startAgentDaemon({ dataDir, modules: [BrowserModule.forRoot({ chromePath: '/nonexistent' })] }));
    await until(
      () => alive(stray),
      (up) => !up,
      'the stray Chrome to be ended',
    );
    expect(alive(other)).toBe(true);
  });
});
