import { output } from './command';

export type ProcessEntry = { pid: number; ppid: number; pgid: number };

export async function processTable(): Promise<ProcessEntry[]> {
  const text = await output('ps', ['-axo', 'pid=,ppid=,pgid=']);
  return text.split('\n').flatMap((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    return pid === undefined || ppid === undefined || pgid === undefined || Number.isNaN(pgid)
      ? []
      : [{ pid, ppid, pgid }];
  });
}

/**
 * `root` and everything it started. A login shell does job control, so its children sit in process groups of their
 * own: the family follows parents and the groups of members, not only the root's group.
 */
export function familyOf(table: ProcessEntry[], root: number): Set<number> {
  const family = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    const groups = new Set(table.filter((entry) => family.has(entry.pid)).map((entry) => entry.pgid));
    for (const entry of table) {
      if (!family.has(entry.pid) && (family.has(entry.ppid) || groups.has(entry.pgid))) {
        family.add(entry.pid);
        grew = true;
      }
    }
  }
  return family;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

export function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}
