import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEMP, TOOL_CACHES } from './run-sandbox';

export type EditScope = {
  /** The folder the run works in. */
  workingDir: string;
  /** The Session's output folder, when the run has one. */
  outputFolder: string | null;
  /** The checkouts of the other Repos the operator opened to the Session. */
  repoFolders?: string[];
  /** The account's Claude Code config folder, where Claude Code keeps its own plans and memory. */
  configDir: string;
  home?: string;
};

/**
 * Where the agent's file tools may write: the folders the Run sandbox lets its commands write in (ADR 0006), plus the
 * account's config folder. File tools run in Claude Code's own process, outside that sandbox, so the console checks
 * their paths itself in every Access mode, `full` included.
 */
export function editRoots(scope: EditScope): string[] {
  const home = scope.home ?? os.homedir();
  return [
    scope.workingDir,
    ...(scope.repoFolders ?? []),
    ...(scope.outputFolder === null ? [] : [scope.outputFolder]),
    scope.configDir,
    ...TEMP,
    os.tmpdir(),
    ...TOOL_CACHES.map((folder) => path.join(home, folder)),
  ];
}

/** The path with symlinks resolved as far as it exists, so a link inside a root cannot lead out of it. */
function resolved(file: string): string {
  const tail: string[] = [];
  let head = path.resolve(file);
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.join(head, ...tail);
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** Whether a file tool's target sits outside every root; a relative path counts from `cwd`. */
export function outsideEditRoots(file: string, roots: string[], cwd: string): boolean {
  const target = resolved(path.resolve(cwd, file));
  return !roots.some((root) => {
    const base = resolved(root);
    return target === base || target.startsWith(base + path.sep);
  });
}
