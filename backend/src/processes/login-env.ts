import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type Env = Record<string, string>;

/** Files in the home folder whose change makes the shell's environment different. */
const HOME_FILES = [
  '.zshenv',
  '.zprofile',
  '.zshrc',
  '.zlogin',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.bashrc',
  '.config/mise/config.toml',
];
/** Per-folder files a version manager reads at shell start: `mise activate` puts a folder's tools on PATH. */
const FOLDER_FILES = [
  'mise.toml',
  '.mise.toml',
  'mise.local.toml',
  '.tool-versions',
  '.nvmrc',
  '.node-version',
  '.python-version',
  '.ruby-version',
  '.envrc',
];
/** What a shell sets for itself or for where it is. */
const SHELL_OWN = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
const MARK = '__OPS_CONSOLE_ENV__';
const CAPTURE_TIMEOUT_MS = 15_000;
const MAX_ENTRIES = 32;

/** What a shell gets from the daemon before its rc files run; the shell adds PATH and the rest. */
export function baseEnv(shell: string): Env {
  const env: Env = { SHELL: shell, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The variables `env -0` printed after `MARK`, or null when the shell did not get that far. */
export function parseEnv(output: string): Env | null {
  const start = output.indexOf(MARK);
  if (start === -1) return null;
  const env: Env = {};
  for (const entry of output.slice(start + MARK.length).split('\0')) {
    const eq = entry.indexOf('=');
    const name = eq > 0 ? entry.slice(0, eq) : '';
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !SHELL_OWN.has(name)) env[name] = entry.slice(eq + 1);
  }
  return env.PATH === undefined ? null : env;
}

function capture(shell: string, folder: string): Promise<Env | null> {
  return new Promise((resolve) => {
    // Its own session: an interactive shell with no terminal must not touch the daemon's.
    const child = spawn(shell, ['-ilc', `printf %s ${MARK}; env -0`], {
      cwd: folder,
      env: baseEnv(shell),
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
      timeout: CAPTURE_TIMEOUT_MS,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code === 0 ? parseEnv(Buffer.concat(chunks).toString('utf8')) : null));
  });
}

async function mtimes(files: string[]): Promise<string> {
  const stamps = await Promise.all(
    files.map((file) =>
      stat(file).then(
        (info) => `${info.mtimeMs}:${info.size}`,
        () => '-',
      ),
    ),
  );
  return stamps.join('|');
}

/** The rc files and the folder's version files, with their modification times. */
function signature(folder: string): Promise<string> {
  const files = HOME_FILES.map((name) => path.join(process.env.HOME ?? os.homedir(), name));
  for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
    for (const name of FOLDER_FILES) files.push(path.join(dir, name));
    if (path.dirname(dir) === dir) break;
  }
  return mtimes(files);
}

type Entry = { stamp: string; env: Env };

/**
 * The environment the operator's login shell builds, read once per folder instead of at every spawn: starting
 * `$SHELL -ilc` costs 0.6 s or more of rc files. A folder has its own because version managers such as mise set PATH
 * from the folder's own files. An entry is read again when an rc file or a version file changes.
 */
export class LoginEnv {
  private readonly entries = new Map<string, Entry>();
  private readonly reading = new Map<string, Promise<void>>();

  /** The environment for a command in `folder`, or null while it is being read: the caller runs the login shell itself. */
  async get(shell: string, folder: string): Promise<Env | null> {
    const key = `${shell}\0${folder}`;
    const stamp = await signature(folder);
    const entry = this.entries.get(key);
    if (entry?.stamp === stamp) return entry.env;
    if (!this.reading.has(key)) {
      const reading = capture(shell, folder)
        .then((env) => {
          if (!env) return;
          this.entries.delete(key);
          this.entries.set(key, { stamp, env });
          for (const old of [...this.entries.keys()].slice(0, Math.max(0, this.entries.size - MAX_ENTRIES))) {
            this.entries.delete(old);
          }
        })
        .finally(() => this.reading.delete(key));
      this.reading.set(key, reading);
    }
    return null;
  }

  /** Starts reading the environment for `folder` in the background, so the first command there skips the shell's start-up. */
  warm(shell: string, folder: string): void {
    void this.get(shell, folder);
  }
}
