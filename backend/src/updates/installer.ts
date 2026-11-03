import { spawn } from 'node:child_process';
import path from 'node:path';

export const INSTALLER = Symbol('INSTALLER');

/** Installs a release over the running console and starts it again on the new version. */
export interface Installer {
  /** Puts `version` in place; the running daemon keeps going on the old one until `restart`. */
  install(version: string): Promise<void>;
  /** Stops this daemon; launchd (`KeepAlive`) starts it again from `current`, now the new version. */
  restart(): void;
}

/** Runs the `install.sh` of the installed version, which points `current` at the new one. */
export class ScriptInstaller implements Installer {
  /** `versionRoot`: the installed version folder, which holds `install.sh`. */
  constructor(private readonly versionRoot: string) {}

  install(version: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('sh', [path.join(this.versionRoot, 'install.sh')], {
        env: { ...process.env, OPS_CONSOLE_VERSION: version },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim().split('\n').at(-1) || `install.sh exited ${code}`));
      });
    });
  }

  restart(): void {
    // A moment for the answer and the `update.changed` event to leave first.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
  }
}
