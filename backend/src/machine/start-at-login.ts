import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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

/** Whether launchd starts the daemon at login, which macOS shows under App Background Activity. */
export interface StartAtLoginGate {
  check(): Promise<StartAtLogin>;
  /** Opens Login Items & Extensions in System Settings. */
  openSettings(): Promise<void>;
}

export class MacStartAtLogin implements StartAtLoginGate {
  async check(): Promise<StartAtLogin> {
    if (process.platform !== 'darwin') return { on: null, dev_build: false };
    const app = appPath();
    // `pnpm dev` runs its app only while it runs, from a plist outside LaunchAgents, so login never starts it.
    if (app === null || app.endsWith(' (dev).app')) return { on: false, dev_build: true };
    return { on: existsSync(PLIST) && !(await this.disabled()), dev_build: false };
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
