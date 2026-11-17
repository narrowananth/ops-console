import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FolderTarget } from '@ops-console/shared';

const exec = promisify(execFile);

export const FOLDER_OPENER = Symbol('FOLDER_OPENER');

/** Opens a folder of this machine in the operator's editor or file manager. */
export type FolderOpener = (dir: string, target: FolderTarget) => Promise<void>;

/**
 * The daemon runs on the operator's machine and takes no address from outside (ADR 0003), so it opens a folder it
 * chose itself: the Session's worktree. Fixed programs, the folder as the only argument, no shell.
 */
export const openFolder: FolderOpener = async (dir, target) => {
  const editor = target === FolderTarget.Editor;
  const [bin, args]: [string, string[]] =
    process.platform === 'darwin'
      ? editor
        ? ['open', ['-a', 'Visual Studio Code', dir]]
        : ['open', [dir]]
      : editor
        ? ['code', [dir]]
        : ['xdg-open', [dir]];
  await exec(bin, args, { timeout: 10_000 });
};
