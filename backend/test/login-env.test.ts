import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LoginEnv } from '../src/processes/login-env';
import { type AgentDaemon, until, WORKING_DIR } from './agent-fixtures';
import { tempDir } from './helpers';
import { startProcess, startProcessDaemon, watch } from './process-fixtures';

const running: AgentDaemon[] = [];
const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME };
afterEach(async () => {
  process.env.SHELL = saved.SHELL;
  process.env.HOME = saved.HOME;
  for (const daemon of running.splice(0)) await daemon.stop();
});

/** A login shell stand-in: only `-ilc` reads `$HOME/.zshrc`, as zsh does, and each read leaves a line in `rc-reads`. */
async function fakeShell(home: string): Promise<string> {
  const shell = path.join(home, 'fake-shell');
  await writeFile(
    shell,
    `#!/bin/sh\ncase "$1" in -ilc) echo read >> "${home}/rc-reads"; . "${home}/.zshrc";; esac\nexec /bin/sh -c "$2"\n`,
  );
  await chmod(shell, 0o755);
  return shell;
}

const rc = (marker: string) => `export OPS_MARK=${marker}\nexport PATH="$HOME/bin:$PATH"\n`;
const reads = async (home: string) =>
  (await readFile(path.join(home, 'rc-reads'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

describe('a Session process and the login environment', () => {
  it('finds the rc file’s variables and PATH without reading the rc file again, and reads it again when it changes', async () => {
    const home = await tempDir('ops-console-home-');
    await mkdir(path.join(home, 'bin'));
    await writeFile(path.join(home, 'bin', 'ops-tool'), '#!/bin/sh\necho tool-ok\n', { mode: 0o755 });
    await writeFile(path.join(home, '.zshrc'), rc('one'));
    const shell = await fakeShell(home);
    const daemon = await startProcessDaemon();
    running.push(daemon);
    const sessionId = daemon.createSession();
    process.env.SHELL = shell;
    process.env.HOME = home;

    const ask = async (name: string) => {
      const started = await startProcess(daemon, sessionId, { name, command: 'echo "m=$OPS_MARK t=$(ops-tool)"' });
      return (await watch(daemon, started.id)).wait('t=');
    };
    const ready = (expected: string) =>
      until(
        () => daemon.app.get(LoginEnv).get(shell, WORKING_DIR),
        (env) => env?.OPS_MARK === expected,
        `the login environment with ${expected}`,
      );

    // Before the environment is read, a command runs in the login shell itself.
    expect(await ask('cold')).toContain('m=one t=tool-ok');
    await ready('one');
    const before = await reads(home);

    expect(await ask('warm')).toContain('m=one t=tool-ok');
    expect(await reads(home)).toBe(before);

    await writeFile(path.join(home, '.zshrc'), `${rc('two')}# edited\n`);
    expect(await ask('edited')).toContain('m=two t=tool-ok');
    await ready('two');
    expect(await ask('again')).toContain('m=two t=tool-ok');
  });
});
