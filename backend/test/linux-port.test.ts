import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode } from '@ops-console/shared';
import { describe, expect, it } from 'vitest';
import { LINUX_RUN_SANDBOX_PENDING, runSandbox } from '../src/agent/run-sandbox';
import { defaultDataDir } from '../src/common/platform';
import { linuxInstallAdvice } from '../src/connectors/connectors.service';
import { type KeychainEntry, KeychainTimeout, LoginKeychain, SecretServiceUnavailable } from '../src/keychain/keychain';
import { LSOF_MISSING, LsofScanner } from '../src/processes/local-servers';
import { LinuxFolderPicker } from '../src/repos/folder-picker';
import { BubblewrapRunSandbox, type Program } from '../src/terminals/run-sandbox-gate';
import { SystemdStartAtLogin } from '../src/terminals/start-at-login';
import { tempDir } from './helpers';

/** A native item that fails as the Secret Service does with no D-Bus session. */
class NoServiceEntry implements KeychainEntry {
  async setPassword(): Promise<void> {
    throw new Error('Platform secure storage failure: no D-Bus session\nmore detail');
  }
  async getPassword(): Promise<string | null> {
    throw new Error('Platform secure storage failure: no D-Bus session\nmore detail');
  }
  async deletePassword(): Promise<void> {
    throw new Error('Platform secure storage failure: no D-Bus session');
  }
}

/** A native item the keyring never answers, as when it waits for its unlock prompt. */
class LockedEntry implements KeychainEntry {
  setPassword = () => new Promise<void>(() => {});
  getPassword = () => new Promise<string | null>(() => {});
  deletePassword = () => new Promise<void>(() => {});
}

class MemoryEntry implements KeychainEntry {
  stored: string | null = null;
  async setPassword(value: string): Promise<void> {
    this.stored = value;
  }
  async getPassword(): Promise<string | null> {
    return this.stored;
  }
  async deletePassword(): Promise<void> {
    this.stored = null;
  }
}

describe('Secrets on Linux (Behavior 13 to 18)', () => {
  it('keeps a secret in the Secret Service and reads it back (13)', async () => {
    const entry = new MemoryEntry();
    const keychain = new LoginKeychain('t', undefined, { entry: () => entry, platform: 'linux' });
    await keychain.set('connection:a', 's3cret');
    expect(entry.stored).toBe('s3cret');
    await expect(keychain.get('connection:a')).resolves.toBe('s3cret');
  });

  it('refuses a save with the reason when no Secret Service answers (16)', async () => {
    const keychain = new LoginKeychain('t', undefined, { entry: () => new NoServiceEntry(), platform: 'linux' });
    const refused = await keychain.set('connection:a', 'x').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SecretServiceUnavailable);
    expect(refused).toMatchObject({ status: 409, code: ErrorCode.InvalidState });
    expect((refused as Error).message).toContain('Platform secure storage failure: no D-Bus session');
    expect((refused as Error).message).not.toContain('more detail');
  });

  it('reads nothing and deletes nothing without a Secret Service, so a Connection with no secret still works (16)', async () => {
    const keychain = new LoginKeychain('t', undefined, { entry: () => new NoServiceEntry(), platform: 'linux' });
    await expect(keychain.get('connection:a')).resolves.toBeNull();
    await expect(keychain.delete('connection:a')).resolves.toBeUndefined();
  });

  it('leaves a macOS failure as it was (34)', async () => {
    const keychain = new LoginKeychain('t', undefined, { entry: () => new NoServiceEntry(), platform: 'darwin' });
    await expect(keychain.set('connection:a', 'x')).rejects.not.toBeInstanceOf(SecretServiceUnavailable);
  });

  it('keeps timing out a call the keyring never answers (15)', async () => {
    const keychain = new LoginKeychain('t', undefined, {
      entry: () => new LockedEntry(),
      platform: 'linux',
      callMs: 20,
    });
    await expect(keychain.get('connection:a')).rejects.toBeInstanceOf(KeychainTimeout);
  });

  it('reports itself available when the Secret Service answers, and when it waits for an unlock (16)', async () => {
    const answers = new LoginKeychain('t', undefined, { entry: () => new MemoryEntry(), platform: 'linux' });
    await expect(answers.availability()).resolves.toEqual({ available: true, reason: null, store: 'secret_service' });
    const locked = new LoginKeychain('t', undefined, {
      entry: () => new LockedEntry(),
      platform: 'linux',
      probeMs: 20,
    });
    await expect(locked.availability()).resolves.toEqual({ available: true, reason: null, store: 'secret_service' });
  });

  it('reports itself unavailable, with the reason and no secret, when none answers (16)', async () => {
    const keychain = new LoginKeychain('t', undefined, { entry: () => new NoServiceEntry(), platform: 'linux' });
    await expect(keychain.availability()).resolves.toEqual({
      available: false,
      reason: 'no Secret Service answered: Platform secure storage failure: no D-Bus session',
      store: 'secret_service',
    });
  });

  it('is always available on a Mac (34)', async () => {
    const keychain = new LoginKeychain('t', undefined, { entry: () => new NoServiceEntry(), platform: 'darwin' });
    await expect(keychain.availability()).resolves.toEqual({ available: true, reason: null, store: 'keychain' });
  });

  it('asks the Secret Service once for two reads in a row', async () => {
    let calls = 0;
    const entry = new MemoryEntry();
    const keychain = new LoginKeychain('t', undefined, {
      entry: () => {
        calls += 1;
        return entry;
      },
      platform: 'linux',
    });
    await keychain.availability();
    await keychain.availability();
    expect(calls).toBe(1);
  });
});

describe('the data folder', () => {
  it('is Application Support on a Mac and the XDG data folder on Linux (6)', () => {
    expect(defaultDataDir({ home: '/h', platform: 'darwin' })).toBe('/h/Library/Application Support/ops-console');
    expect(defaultDataDir({ home: '/h', platform: 'linux', xdgDataHome: undefined })).toBe(
      '/h/.local/share/ops-console',
    );
    expect(defaultDataDir({ home: '/h', platform: 'linux', xdgDataHome: '/data' })).toBe('/data/ops-console');
    expect(defaultDataDir({ home: '/h', platform: 'linux', xdgDataHome: 'relative' })).toBe(
      '/h/.local/share/ops-console',
    );
  });
});

describe('the Run sandbox on Linux (Behavior 21, 22)', () => {
  it('starts no run on Linux until the sandbox is verified there (21)', () => {
    expect(() => runSandbox({ workingDir: '/w' }, 'linux')).toThrow(LINUX_RUN_SANDBOX_PENDING);
  });

  it('still builds the macOS rules on a Mac (34)', () => {
    expect(runSandbox({ workingDir: '/w', home: '/h' }, 'darwin')).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      filesystem: { denyRead: ['/h/.ops-console', '/h/Library/Keychains'] },
    });
  });

  const present =
    (...missing: string[]): Program =>
    async (file, args) => {
      if (missing.includes(file)) throw new Error('not found');
      if (file === 'bwrap' && args[0] === '--ro-bind' && missing.includes('userns')) {
        throw new Error('bwrap: setting up uid map: Permission denied');
      }
    };
  const linux = '5.15.0-generic';

  it('names a missing bubblewrap and socat with the install command (22)', async () => {
    const gate = (missing: string[], kernel = linux) =>
      new BubblewrapRunSandbox({ program: present(...missing), kernel: async () => kernel, verified: true });
    expect(await gate(['bwrap']).check()).toMatchObject({ status: 'unavailable' });
    expect((await gate(['bwrap']).check()).reason).toContain('bubblewrap is not installed');
    expect((await gate(['socat']).check()).reason).toContain('socat is not installed');
    expect((await gate(['socat']).check()).reason).toContain('apt install bubblewrap socat');
  });

  it('names the AppArmor limit when user namespaces fail (22)', async () => {
    const gate = new BubblewrapRunSandbox({ program: present('userns'), kernel: async () => linux, verified: true });
    const checked = await gate.check();
    expect(checked.status).toBe('unavailable');
    expect(checked.reason).toContain('setting up uid map');
    expect(checked.reason).toContain('AppArmor');
  });

  it('says WSL2 is required on WSL1 and accepts WSL2 (22)', async () => {
    const wsl1 = new BubblewrapRunSandbox({
      program: present(),
      kernel: async () => '4.4.0-19041-Microsoft',
      verified: true,
    });
    expect((await wsl1.check()).reason).toContain('needs WSL2');
    const wsl2 = new BubblewrapRunSandbox({
      program: present(),
      kernel: async () => '5.15.0-microsoft-standard-WSL2',
      verified: true,
    });
    expect(await wsl2.check()).toEqual({ status: 'on', reason: null });
  });

  it('stays unavailable with every piece present while the Linux rules are unverified (21)', async () => {
    const gate = new BubblewrapRunSandbox({ program: present(), kernel: async () => linux });
    expect(await gate.check()).toEqual({ status: 'unavailable', reason: LINUX_RUN_SANDBOX_PENDING });
  });
});

describe('Start at login on Linux (Behavior 10, 11)', () => {
  async function fixture() {
    // A real path, as `process.execPath` is: the macOS temp folder sits behind a link.
    const home = await realpath(await tempDir('ops-console-home-'));
    const unitFile = path.join(home, '.config', 'systemd', 'user', 'ops-console.service');
    await mkdir(path.dirname(unitFile), { recursive: true });
    return { home, unitFile, execPath: path.join(home, '.ops-console', 'versions', '1.0.0', 'node', 'bin', 'node') };
  }
  const exec =
    (enabled: string | Error, linger: string | Error) =>
    async (file: string): Promise<string> => {
      const answer = file === 'systemctl' ? enabled : linger;
      if (answer instanceof Error) throw answer;
      return answer;
    };

  it('is on when the unit exists and is enabled, and reports lingering (10, 11)', async () => {
    const { home, unitFile, execPath } = await fixture();
    await writeFile(unitFile, '[Service]\n');
    const gate = (linger: string) =>
      new SystemdStartAtLogin({ home, unitFile, execPath, user: 'u', exec: exec('enabled\n', linger) });
    expect(await gate('yes\n').check()).toEqual({ on: true, dev_build: false, manager: 'systemd', lingering: true });
    expect(await gate('no\n').check()).toEqual({ on: true, dev_build: false, manager: 'systemd', lingering: false });
  });

  it('is off when the unit was disabled by `ops-console stop` or never written (10)', async () => {
    const { home, unitFile, execPath } = await fixture();
    const disabled = new SystemdStartAtLogin({ home, unitFile, execPath, exec: exec(new Error('disabled'), 'no') });
    expect((await disabled.check()).on).toBe(false);
    const missing = new SystemdStartAtLogin({ home, unitFile, execPath, exec: exec('enabled', 'no') });
    expect((await missing.check()).on).toBe(false);
  });

  it('reads lingering as unknown when loginctl is missing (11)', async () => {
    const { home, unitFile, execPath } = await fixture();
    await writeFile(unitFile, '[Service]\n');
    const gate = new SystemdStartAtLogin({ home, unitFile, execPath, exec: exec('enabled', new Error('no loginctl')) });
    expect((await gate.check()).lingering).toBeNull();
  });

  it('is a dev build when the daemon does not run from an installed version (10)', async () => {
    const { home, unitFile } = await fixture();
    const gate = new SystemdStartAtLogin({ home, unitFile, execPath: '/usr/bin/node', exec: exec('enabled', 'yes') });
    expect(await gate.check()).toEqual({ on: false, dev_build: true, manager: 'systemd', lingering: null });
  });
});

describe('the folder dialog on Linux (Behavior 29)', () => {
  const failing = (code: unknown) => Object.assign(new Error('failed'), { code });

  it('returns the folders zenity prints, one per line', async () => {
    const picker = new LinuxFolderPicker(async (file) => {
      expect(file).toBe('zenity');
      return '/home/u/api/\n/home/u/web\n';
    });
    expect(await picker.pick()).toEqual(['/home/u/api', '/home/u/web']);
  });

  it('falls back to kdialog when zenity is not installed', async () => {
    const seen: string[] = [];
    const picker = new LinuxFolderPicker(async (file) => {
      seen.push(file);
      if (file === 'zenity') throw failing('ENOENT');
      return '/home/u/api\n';
    });
    expect(await picker.pick()).toEqual(['/home/u/api']);
    expect(seen).toEqual(['zenity', 'kdialog']);
  });

  it('reports a dialog that could not open a display as a failure, not a cancel', async () => {
    const picker = new LinuxFolderPicker(async () => {
      throw Object.assign(new Error('failed'), { code: 1, stderr: 'Gtk-WARNING: cannot open display' });
    });
    await expect(picker.pick()).rejects.toMatchObject({ status: 502, code: ErrorCode.UpstreamFailed });
  });

  it('returns no folder when the dialog is closed', async () => {
    const picker = new LinuxFolderPicker(async () => {
      throw failing(1);
    });
    expect(await picker.pick()).toEqual([]);
  });

  it('says to type the path when no dialog tool is installed', async () => {
    const picker = new LinuxFolderPicker(async () => {
      throw failing('ENOENT');
    });
    await expect(picker.pick()).rejects.toMatchObject({ status: 409, code: ErrorCode.InvalidState });
  });
});

describe('the folder dialog is offered only where one can open (Behavior 29)', () => {
  const never = async () => '';

  it('is unavailable with no display, or with neither zenity nor kdialog on the PATH', async () => {
    const bin = await tempDir('ops-console-bin-');
    await writeFile(path.join(bin, 'zenity'), '#!/bin/sh\n', { mode: 0o755 });
    expect(await new LinuxFolderPicker(never, { display: '', path: bin }).available()).toBe(false);
    expect(
      await new LinuxFolderPicker(never, { display: ':0', path: await tempDir('ops-console-empty-') }).available(),
    ).toBe(false);
  });

  it('is available with a display and either program installed', async () => {
    const bin = await tempDir('ops-console-bin-');
    await writeFile(path.join(bin, 'kdialog'), '#!/bin/sh\n', { mode: 0o755 });
    expect(await new LinuxFolderPicker(never, { display: ':0', path: bin }).available()).toBe(true);
  });
});

describe('the server list on a machine with no lsof (Behavior 31)', () => {
  it('lists nothing and says why, and says nothing when lsof is there', async () => {
    const was = process.env.PATH;
    const scanner = new LsofScanner();
    try {
      process.env.PATH = await tempDir('ops-console-empty-');
      expect(await scanner.scan()).toEqual([]);
      expect(scanner.notice()).toBe(LSOF_MISSING);
      // `lsof` installed, and listening to nothing: it exits 1 with no output.
      const bin = await tempDir('ops-console-lsof-');
      await writeFile(path.join(bin, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      process.env.PATH = bin;
      const found = new LsofScanner();
      expect(await found.scan()).toEqual([]);
      expect(found.notice()).toBeNull();
    } finally {
      process.env.PATH = was;
    }
  });
});

describe('a missing CLI on Linux (Behavior 33)', () => {
  it('names the package manager, and Homebrew only when it is installed, and runs neither', () => {
    expect(linuxInstallAdvice(['gh'], false)).toBe(
      'gh is not installed: install it with your package manager, then Connect again',
    );
    expect(linuxInstallAdvice(['pup', 'gh'], true)).toBe(
      'pup, gh are not installed: install them with your package manager, or with Homebrew: `brew install pup gh`, then Connect again',
    );
  });
});
