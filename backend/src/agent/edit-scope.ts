import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEMP = ['/tmp', '/private/tmp'];

/** Where build tools keep their downloads, under the operator's home. */
export const TOOL_CACHES = [
  '.npm',
  '.pnpm-store',
  '.yarn',
  '.cache',
  '.cargo/registry',
  '.cargo/git',
  '.cargo/.package-cache',
  'go/pkg',
  '.m2/repository',
  '.gradle',
  '.nuget/packages',
  'Library/Caches',
  'Library/pnpm',
];

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
 * The folders that count as the run's own: its working folder, output folder, opened Repos, config folder, temp and tool
 * caches. `run_integration` runs a CLI outside the sandbox with the operator's sign-in, so it refuses a file argument
 * outside them.
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
