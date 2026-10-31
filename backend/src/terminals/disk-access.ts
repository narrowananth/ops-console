import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DiskAccess } from '@ops-console/shared';

const run = promisify(execFile);

/** Settings › Privacy & Security › Full Disk Access. */
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
/** macOS keeps it behind Full Disk Access, so opening it tells whether the daemon has it. */
const PROBE = path.join('Library', 'Application Support', 'com.apple.TCC', 'TCC.db');

export const DISK_ACCESS = Symbol('DISK_ACCESS');

/** macOS Full Disk Access for the daemon: the one permission the operator grants before the Setup agent reads. */
export interface DiskAccessGate {
  check(): Promise<DiskAccess>;
  /** Opens the Full Disk Access pane in System Settings. */
  openSettings(): Promise<void>;
}

export class MacDiskAccess implements DiskAccessGate {
  async check(): Promise<DiskAccess> {
    if (process.platform !== 'darwin') return { granted: null, app_path: null };
    return { granted: await this.probe(), app_path: appPath() };
  }

  /** With the app in a Finder window beside it, so the operator can drag it into the list. */
  async openSettings(): Promise<void> {
    if (process.platform !== 'darwin') return;
    await run('open', [SETTINGS_URL]);
    const app = appPath();
    if (app) await run('open', ['-R', app]);
  }

  private async probe(): Promise<boolean> {
    try {
      await (await open(path.join(os.homedir(), PROBE), 'r')).close();
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code !== 'EPERM' && code !== 'EACCES';
    }
  }
}

/** `Ops Console.app` when the daemon runs as it, as the installed one does; null under `pnpm dev`. */
function appPath(): string | null {
  return /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(process.execPath)?.[1] ?? null;
}
