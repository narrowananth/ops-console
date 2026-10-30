import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
export const DAEMON_FILE = path.join(tmpdir(), 'ops-console-e2e-daemon.json');

function build(dir: string, args: string[]): void {
  const result = spawnSync(args[0] ?? '', args.slice(1), { cwd: path.join(repo, dir), stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${dir} build failed`);
}

/** Builds the daemon and UI, lays them out as the release tarball does, and starts the daemon. */
export default async function setup(): Promise<() => Promise<void>> {
  build('backend', [process.execPath, 'scripts/build.mjs']);
  build('frontend', ['pnpm', 'exec', 'vite', 'build', '--logLevel', 'warn']);

  const app = await mkdtemp(path.join(tmpdir(), 'ops-console-e2e-app-'));
  await cp(path.join(repo, 'backend/dist'), app, { recursive: true });
  await cp(path.join(repo, 'frontend/dist'), path.join(app, 'public'), { recursive: true });
  await writeFile(path.join(app, 'package.json'), '{ "type": "module" }\n');
  await symlink(path.join(repo, 'backend/node_modules'), path.join(app, 'node_modules'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ops-console-e2e-data-'));

  const daemon: ChildProcess = spawn(process.execPath, [path.join(app, 'main.js')], {
    env: { ...process.env, OPS_CONSOLE_DATA_DIR: dataDir, OPS_CONSOLE_PORT: '0' },
    stdio: 'inherit',
  });
  const runtimeFile = path.join(dataDir, 'runtime.json');
  const deadline = Date.now() + 15_000;
  let runtime: { port: number; token: string } | null = null;
  while (runtime === null) {
    if (Date.now() > deadline) throw new Error('daemon did not start');
    runtime = await readFile(runtimeFile, 'utf8').then(JSON.parse, () => null);
    if (runtime === null) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeFile(DAEMON_FILE, JSON.stringify({ url: `http://127.0.0.1:${runtime.port}`, token: runtime.token }));

  return async () => {
    daemon.kill('SIGTERM');
    await new Promise((resolve) => daemon.once('exit', resolve));
  };
}
