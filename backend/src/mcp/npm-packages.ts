import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

/** Runs `npm <args>` and resolves with its stdout. Tests pass a fake. */
export type NpmRunner = (args: string[]) => Promise<string>;

export interface PackageDeps {
  npm: NpmRunner;
  now: () => number;
  /** How long a start waits for another process's install before it gives up and runs `npx`. */
  lockTimeoutMs: number;
}

/** What to spawn. `dir` is the version folder it runs from; null when it is the plain command. */
export type Prepared = { command: string; args: string[]; dir: string | null };

/** A server that dies this fast with a missing module has a broken install. */
export const QUICK_FAIL_MS = 10_000;

const REFRESH_MS = 24 * 60 * 60 * 1000;
const STALE_LOCK_MS = 10 * 60 * 1000;
const POLL_MS = 100;
const NPM_TIMEOUT_MS = 10 * 60 * 1000;
const NPM_ENV = { npm_config_update_notifier: 'false', npm_config_fund: 'false' };

const run = promisify(execFile);
const realNpm: NpmRunner = async (args) =>
  (
    await run('npm', args, {
      env: { ...process.env, ...NPM_ENV },
      maxBuffer: 16 * 1024 * 1024,
      timeout: NPM_TIMEOUT_MS,
    })
  ).stdout;

const PACKAGE_NAME = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const VERSION = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/);
const pointerSchema = z.object({ version: VERSION, checkedAt: z.number() });
const manifestSchema = z.object({
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  version: VERSION,
});

/** `-y <pkg>@latest …` or `<pkg> …`: the package and the arguments after it. Any other `npx` form is not ours. */
function parseNpx(args: string[]): { name: string; rest: string[] } | null {
  let first = 0;
  while (args[first] === '-y' || args[first] === '--yes') first++;
  const spec = args[first] ?? '';
  const at = spec.lastIndexOf('@');
  if (at > 0 && spec.slice(at + 1) !== 'latest') return null;
  const name = at > 0 ? spec.slice(0, at) : spec;
  return PACKAGE_NAME.test(name) ? { name, rest: args.slice(first + 1) } : null;
}

/** True when the stderr of a server says a module it needs is not there. */
export function isModuleMissing(stderr: string): boolean {
  return /MODULE_NOT_FOUND|Cannot find module/.test(stderr);
}

/**
 * Removes the install a failed start ran from: the version folder, or for the `npx` fallback the `_npx/<hash>` folder
 * the error's require stack names. The next start installs it again.
 */
export async function discardBroken(prepared: Prepared, stderr: string): Promise<void> {
  const dir = prepared.dir ?? stderr.match(/(\/[^\s'"():]*\/_npx\/[0-9a-f]{16})\//)?.[1];
  if (dir) await rm(dir, { recursive: true, force: true });
}

/**
 * Installs the npm packages that MCP servers start from, once per version, under `base`:
 * `<base>/<package>/<version>/` and `<base>/<package>/current.json`, which names the version a start uses. A version
 * folder is built in a temporary sibling and renamed into place, then never changes, so a start that overlaps an
 * install or a refresh cannot see a half-written one the way it can in the shared `npx` cache.
 */
export class NpmPackages {
  private readonly deps: PackageDeps;
  private readonly refreshing = new Set<Promise<void>>();

  constructor(
    private readonly base: string,
    deps: Partial<PackageDeps> = {},
  ) {
    this.deps = { npm: realNpm, now: Date.now, lockTimeoutMs: 120_000, ...deps };
  }

  /**
   * The command to spawn for `command args`. An `npx` call for one package runs the installed bin directly; any other
   * command, and any failure here, returns the call as it was.
   */
  async prepare(command: string, args: string[]): Promise<Prepared> {
    const plain = { command, args, dir: null };
    const parsed = command === 'npx' ? parseNpx(args) : null;
    if (!parsed) return plain;
    const root = path.join(this.base, parsed.name.replace('/', '_'));
    try {
      const current = (await readCurrent(root)) ?? (await this.installFirst(parsed.name, root));
      const bin = await binOf(current.dir, parsed.name);
      if (!bin) return plain;
      if (this.deps.now() - current.checkedAt >= REFRESH_MS) this.refreshLater(parsed.name, root);
      return { command: bin, args: parsed.rest, dir: current.dir };
    } catch {
      // No npm, no network with nothing installed, or a lock that stayed held: start as before.
      return plain;
    }
  }

  /** Resolves when the background refreshes started so far are done. */
  async settled(): Promise<void> {
    while (this.refreshing.size > 0) await Promise.all([...this.refreshing]);
  }

  private async installFirst(name: string, root: string) {
    await mkdir(root, { recursive: true });
    const release = await this.lock(root, this.deps.lockTimeoutMs);
    if (!release) throw new Error('the install lock stayed held');
    try {
      // Another process may have finished while this one waited.
      return (await readCurrent(root)) ?? (await this.install(name, root, 'latest'));
    } finally {
      await release();
    }
  }

  private refreshLater(name: string, root: string): void {
    const job = this.refresh(name, root)
      .catch(() => {
        // Best effort: the version in use keeps working, and the next day asks again.
      })
      .finally(() => this.refreshing.delete(job));
    this.refreshing.add(job);
  }

  /** At most once a day across processes: the check time is written before npm is asked. */
  private async refresh(name: string, root: string): Promise<void> {
    const release = await this.lock(root, 0);
    if (!release) return;
    try {
      const current = await readCurrent(root);
      if (!current || this.deps.now() - current.checkedAt < REFRESH_MS) return;
      await writePointer(root, { version: current.version, checkedAt: this.deps.now() });
      const latest = VERSION.parse((await this.deps.npm(['view', name, 'version'])).trim());
      if (latest !== current.version) await this.install(name, root, latest);
      await prune(root);
    } finally {
      await release();
    }
  }

  /** Installs `name@version` in a temporary sibling, renames it to its version folder and points `current` at it. */
  private async install(name: string, root: string, version: string) {
    const tmp = await mkdtemp(path.join(root, '.tmp-'));
    try {
      const args = [
        'install',
        '--prefix',
        tmp,
        `${name}@${version}`,
        '--no-audit',
        '--no-fund',
        '--ignore-scripts=false',
      ];
      await this.deps.npm(args);
      const manifest = await readManifest(tmp, name);
      const dir = path.join(root, manifest.version);
      // A folder of that version already there is complete, since it too was renamed into place.
      await rename(tmp, dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
      });
      const checkedAt = this.deps.now();
      await writePointer(root, { version: manifest.version, checkedAt });
      return { dir, checkedAt };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * A lock folder made with `mkdir`, shared by every process. One held by a dead process, or for over ten minutes, is
   * taken over. Resolves with its release, or null when it stayed held past `waitMs`.
   */
  private async lock(root: string, waitMs: number): Promise<(() => Promise<void>) | null> {
    const lock = path.join(root, '.lock');
    const until = this.deps.now() + waitMs;
    for (;;) {
      try {
        await mkdir(lock);
        await writeFile(path.join(lock, 'pid'), String(process.pid));
        return () => rm(lock, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (await this.isStale(lock)) {
        // One rename wins when several processes take over at once.
        const aside = `${lock}.stale-${process.pid}-${this.deps.now()}`;
        await rename(lock, aside)
          .then(() => rm(aside, { recursive: true, force: true }))
          .catch(() => {});
        continue;
      }
      if (this.deps.now() >= until) return null;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private async isStale(lock: string): Promise<boolean> {
    const held = await stat(lock).catch(() => null);
    if (!held) return true;
    if (this.deps.now() - held.mtimeMs > STALE_LOCK_MS) return true;
    const pid = Number(await readFile(path.join(lock, 'pid'), 'utf8').catch(() => ''));
    return Number.isInteger(pid) && pid > 0 && !alive(pid);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The version `current.json` names, when its folder is there. */
async function readCurrent(root: string): Promise<{ dir: string; version: string; checkedAt: number } | null> {
  try {
    const pointer = pointerSchema.parse(JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8')));
    const dir = path.join(root, pointer.version);
    return (await stat(dir)).isDirectory() ? { dir, ...pointer } : null;
  } catch {
    return null;
  }
}

async function writePointer(root: string, pointer: z.infer<typeof pointerSchema>): Promise<void> {
  const file = path.join(root, 'current.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(pointer));
  await rename(tmp, file);
}

async function readManifest(dir: string, name: string) {
  return manifestSchema.parse(JSON.parse(await readFile(path.join(dir, 'node_modules', name, 'package.json'), 'utf8')));
}

/** The file to run: `bin` as a string, else the entry named like the package, else the first. Null when it has none. */
async function binOf(dir: string, name: string): Promise<string | null> {
  const { bin } = await readManifest(dir, name);
  const relative = typeof bin === 'string' ? bin : bin && (bin[name.split('/').pop() ?? ''] ?? Object.values(bin)[0]);
  return relative ? path.resolve(dir, 'node_modules', name, relative) : null;
}

/** Keeps `current` and the newest other version, for a server still running from it, and drops the rest. */
async function prune(root: string): Promise<void> {
  const current = (await readCurrent(root))?.version;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries)
    if (entry.name.startsWith('.tmp-')) await rm(path.join(root, entry.name), { recursive: true, force: true });
  const versions = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== current)
      .map(async (entry) => ({ name: entry.name, at: (await stat(path.join(root, entry.name))).mtimeMs })),
  );
  for (const old of versions.sort((a, b) => b.at - a.at).slice(1))
    await rm(path.join(root, old.name), { recursive: true, force: true });
}
