import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { StartAtLogin } from '@ops-console/shared';
import { appPath } from './disk-access';

const run = promisify(execFile);

/** System Settings › General › Login Items & Extensions, where App Background Activity lists the agent. */
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';
/** The launchd label `ops-console start` loads; the dev build's is `dev.ops-console.dev`. */
const LABEL = 'dev.ops-console';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

export const START_AT_LOGIN = Symbol('START_AT_LOGIN');

/** Whether the service manager starts the daemon at login: launchd, which macOS shows under App Background Activity, or systemd. */
export interface StartAtLoginGate {
  check(): Promise<StartAtLogin>;
  /** Opens Login Items & Extensions in System Settings; nothing on Linux. */
  openSettings(): Promise<void>;
}

export class MacStartAtLogin implements StartAtLoginGate {
  async check(): Promise<StartAtLogin> {
    if (process.platform !== 'darwin') return { on: null, dev_build: false, manager: null, lingering: null };
    const app = appPath();
    // `pnpm dev` runs its app only while it runs, from a plist outside LaunchAgents, so login never starts it.
    if (app === null || app.endsWith(' (dev).app'))
      return { on: false, dev_build: true, manager: 'launchd', lingering: null };
    return { on: existsSync(PLIST) && !(await this.disabled()), dev_build: false, manager: 'launchd', lingering: null };
  }

  async openSettings(): Promise<void> {
    if (process.platform !== 'darwin') return;
    await run('open', [SETTINGS_URL]);
  }

  /** `ops-console stop` disables the label, so it stays stopped across logins until the next start. */
  private async disabled(): Promise<boolean> {
    try {
      const { stdout } = await run('launchctl', ['print-disabled', `gui/${process.getuid?.() ?? 0}`]);
      return new RegExp(`"${LABEL.replaceAll('.', '\\.')}" => (disabled|true)`).test(stdout);
    } catch {
      return false;
    }
  }
}

/** The systemd user unit `ops-console start` writes on Linux; the dev build has none. */
const UNIT = 'ops-console.service';

type Systemctl = (file: string, args: string[]) => Promise<string>;

const runText: Systemctl = async (file, args) => (await run(file, args, { timeout: 5_000 })).stdout;

/**
 * Whether systemd's user manager starts the daemon at login, which on Linux is its service being enabled, and whether
 * lingering keeps it running after the operator logs out. There is no settings pane to open.
 */
export class SystemdStartAtLogin implements StartAtLoginGate {
  constructor(
    private readonly options: {
      execPath?: string;
      home?: string;
      unitFile?: string;
      user?: string;
      exec?: Systemctl;
    } = {},
  ) {}

  async check(): Promise<StartAtLogin> {
    const home = this.options.home ?? os.homedir();
    const execPath = this.options.execPath ?? process.execPath;
    // Only the installed app runs from its version folder; `pnpm dev` runs while it runs and login never starts it.
    // `execPath` is a real path, so a home folder behind a link is resolved the same way.
    const versions = path.join(realpathSync(home), '.ops-console', 'versions');
    if (!execPath.startsWith(`${versions}${path.sep}`)) {
      return { on: false, dev_build: true, manager: 'systemd', lingering: null };
    }
    const exec = this.options.exec ?? runText;
    const unitFile =
      this.options.unitFile ??
      path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', UNIT);
    return {
      on: existsSync(unitFile) && (await this.enabled(exec)),
      dev_build: false,
      manager: 'systemd',
      lingering: await this.lingering(exec),
    };
  }

  /** Nothing to open: the lingering command is shown on the Permissions page. */
  async openSettings(): Promise<void> {}

  /** `ops-console stop` disables the unit, so it stays stopped across logins until the next start. */
  private async enabled(exec: Systemctl): Promise<boolean> {
    try {
      return (await exec('systemctl', ['--user', 'is-enabled', UNIT])).trim() === 'enabled';
    } catch {
      return false;
    }
  }

  private async lingering(exec: Systemctl): Promise<boolean | null> {
    try {
      const user = this.options.user ?? os.userInfo().username;
      const out = await exec('loginctl', ['show-user', user, '--property=Linger', '--value']);
      return out.trim() === 'yes';
    } catch {
      return null;
    }
  }
}

/** The start-at-login gate for this machine's system. */
export function startAtLoginGate(platform: NodeJS.Platform = process.platform): StartAtLoginGate {
  return platform === 'linux' ? new SystemdStartAtLogin() : new MacStartAtLogin();
}
