// Copies the installed app's state.db into the dev data folder, so `pnpm dev` shows real data.
// A one-way snapshot taken with SQLite's online backup: the installed app keeps running and is never written.
// The dev copy it replaces is kept beside it as state.db.before-sync.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const source = path.join(homedir(), 'Library', 'Application Support', 'ops-console', 'state.db');
const dataDir = path.resolve(import.meta.dirname, '../backend/.data');
const target = path.join(dataDir, 'state.db');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const lock = path.join(dataDir, 'daemon.lock');
if (existsSync(lock) && alive(Number.parseInt(readFileSync(lock, 'utf8'), 10))) {
  console.error('The dev backend is running. Stop `pnpm dev` first.');
  process.exit(1);
}
if (!existsSync(source)) {
  console.error(`No installed app data at ${source}`);
  process.exit(1);
}
if (existsSync(target)) copyFileSync(target, `${target}.before-sync`);
for (const suffix of ['-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true });
rmSync(target, { force: true });
execFileSync('sqlite3', ['-readonly', source, `.backup '${target}'`], { stdio: 'inherit' });
console.log(`Copied ${source} to ${target}`);
