import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(import.meta.dirname, '../..');
const FAKES = path.join(import.meta.dirname, 'fakes');

export async function tempDir(prefix = 'ops-console-cli-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/**
 * A release folder shaped like a GitHub Release: the tarball and checksums.txt. The tarball's Node is a
 * link to the Node running the tests, and its native modules come from the backend's node_modules.
 */
export async function makeRelease(version: string, arch: 'arm64' | 'x64' = 'arm64'): Promise<string> {
  const stage = await tempDir('stage-');
  await writeFile(path.join(stage, 'VERSION'), `${version}\n`);
  await mkdir(path.join(stage, 'bin'));
  await cp(path.join(REPO, 'cli/bin/ops-console'), path.join(stage, 'bin/ops-console'));
  await mkdir(path.join(stage, 'node/bin'), { recursive: true });
  await symlink(process.execPath, path.join(stage, 'node/bin/node'));
  await mkdir(path.join(stage, 'cli'));
  await cp(path.join(REPO, 'cli/dist/ops-console.js'), path.join(stage, 'cli/ops-console.js'));
  await writeFile(path.join(stage, 'cli/package.json'), '{ "type": "module" }\n');
  await cp(path.join(REPO, 'backend/dist'), path.join(stage, 'app'), { recursive: true });
  await writeFile(path.join(stage, 'app/package.json'), '{ "type": "module" }\n');
  await symlink(path.join(REPO, 'backend/node_modules'), path.join(stage, 'app/node_modules'));
  await cp(path.join(REPO, 'install.sh'), path.join(stage, 'install.sh'));

  const release = await tempDir('release-');
  const tarball = `ops-console-darwin-${arch}.tar.gz`;
  const tar = spawnSync('tar', ['-czf', path.join(release, tarball), '-C', stage, '.']);
  if (tar.status !== 0) throw new Error(String(tar.stderr));
  const sum = createHash('sha256')
    .update(await readFile(path.join(release, tarball)))
    .digest('hex');
  await writeFile(path.join(release, 'checksums.txt'), `${sum}  ${tarball}\n`);
  return release;
}

export type Machine = {
  home: string;
  env: NodeJS.ProcessEnv;
  installDir: string;
  dataDir: string;
  logFile: string;
  calls(): Promise<string[]>;
  opened(): Promise<string[]>;
};

/** A fresh HOME with fake launchctl, open and uname first on PATH. */
export async function machine(release: string, port: number): Promise<Machine> {
  const home = await tempDir('home-');
  const state = path.join(home, '.fake-launchctl');
  const openRecord = path.join(home, '.fake-open');
  return {
    home,
    installDir: path.join(home, '.ops-console'),
    dataDir: path.join(home, 'Library/Application Support/ops-console'),
    logFile: path.join(home, 'Library/Logs/ops-console/daemon.log'),
    env: {
      HOME: home,
      PATH: [FAKES, path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      OPS_CONSOLE_RELEASE_URL: `file://${release}`,
      OPS_CONSOLE_PORT: String(port),
      OPS_CONSOLE_START_TIMEOUT_MS: '15000',
      FAKE_LAUNCHCTL_STATE: state,
      FAKE_OPEN_RECORD: openRecord,
      FAKE_UNAME_S: 'Darwin',
      FAKE_UNAME_M: 'arm64',
    },
    async calls() {
      return (await readFile(path.join(state, 'calls.log'), 'utf8').catch(() => '')).trim().split('\n');
    },
    async opened() {
      return (await readFile(openRecord, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    },
  };
}

export type Result = { code: number | null; stdout: string; stderr: string };

export function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

export function install(m: Machine, env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return run('sh', [path.join(REPO, 'install.sh')], { ...m.env, ...env });
}

export function opsConsole(m: Machine, ...args: string[]): Promise<Result> {
  return run(path.join(m.home, '.local/bin/ops-console'), args, m.env);
}

/** Stops a daemon a test left running. */
export async function cleanup(m: Machine): Promise<void> {
  await run('launchctl', ['bootout', `gui/${process.getuid?.()}/dev.ops-console`], m.env);
}
