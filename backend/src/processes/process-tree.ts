import { output } from './command';

export type ProcessEntry = { pid: number; ppid: number; pgid: number; command: string };

let last: { at: number; table: Promise<ProcessEntry[]> } | null = null;

/**
 * Every process with its parent, group and executable. A reading no older than `maxAgeMs` is shared, and callers that
 * arrive while one runs wait for it: the local-server scan and the process list share one `ps`. Stopping a process
 * reads fresh (the default).
 */
export function processTable(maxAgeMs = 0): Promise<ProcessEntry[]> {
  if (last && Date.now() - last.at <= maxAgeMs) return last.table;
  const table = output('ps', ['-axo', 'pid=,ppid=,pgid=,comm=']).then((text) =>
    text.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match
        ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] ?? '' }]
        : [];
    }),
  );
  const mine = { at: Date.now(), table };
  last = mine;
  table.catch(() => {
    if (last === mine) last = null;
  });
  return table;
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

/** `root` and the processes it started, by parent links only: no process group is followed. */
export function descendantsOf(table: ProcessEntry[], root: number): Set<number> {
  const found = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const entry of table) {
      if (!found.has(entry.pid) && found.has(entry.ppid)) {
        found.add(entry.pid);
        grew = true;
      }
    }
  }
  return found;
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
