import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Ends a Chrome that an earlier daemon left behind after it was killed: any process whose command line names a profile
 * folder under `<dataDir>/browser/`. A daemon never starts with a Chrome of its own running, so these have no owner.
 */
export async function killOrphanChromes(dataDir: string): Promise<number> {
  const marker = `--user-data-dir=${path.join(dataDir, 'browser')}${path.sep}`;
  let listing: string;
  try {
    listing = (await run('ps', ['-axo', 'pid=,command='], { maxBuffer: 20_000_000 })).stdout;
  } catch {
    return 0;
  }
  let killed = 0;
  for (const line of listing.split('\n')) {
    if (!line.includes(marker)) continue;
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed++;
    } catch {}
  }
  return killed;
}
