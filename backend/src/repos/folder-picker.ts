import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ErrorCode } from '@ops-console/shared';
import { ApiError } from '../common/errors';

const run = promisify(execFile);

export const FOLDER_PICKER = Symbol('FOLDER_PICKER');

/** The operating system's own folder dialog, opened on this machine. Tests replace it. */
export interface FolderPicker {
  /** The chosen folders, one or more; empty when the operator closes the dialog. */
  pick(options?: PickOptions): Promise<string[]>;
  /** Whether a dialog can open here; absent where one always can. */
  available?(): Promise<boolean>;
}

/** The dialog asks for several git repositories unless told otherwise. */
export type PickOptions = { prompt?: string; multiple?: boolean };

/** One folder path per line: a path can hold any character but a line break. */
const script = ({ prompt = 'Choose one or more git repositories', multiple = true }: PickOptions) => [
  'tell application "System Events" to activate',
  `set picked to choose folder with prompt ${JSON.stringify(prompt)}${multiple ? ' with multiple selections allowed' : ''}`,
  'set out to ""',
  'if class of picked is not list then set picked to {picked}',
  'repeat with folder_ in picked',
  'set out to out & POSIX path of folder_ & linefeed',
  'end repeat',
  'return out',
];

/** The Finder's folder dialog through `osascript`. The daemon is local-only (ADR 0003), so the dialog is on the operator's screen. */
export class MacFolderPicker implements FolderPicker {
  async pick(options: PickOptions = {}): Promise<string[]> {
    if (process.platform !== 'darwin') {
      throw new ApiError(409, ErrorCode.InvalidState, 'The folder dialog needs macOS: type the path instead');
    }
    try {
      const { stdout } = await run(
        'osascript',
        script(options).flatMap((line) => ['-e', line]),
        { timeout: 10 * 60_000 },
      );
      return stdout
        .split('\n')
        .map((line) => line.trim().replace(/(.)\/$/, '$1'))
        .filter(Boolean);
    } catch (error) {
      // -128 is "User canceled".
      if (String((error as { stderr?: unknown }).stderr).includes('-128')) return [];
      throw new ApiError(502, ErrorCode.UpstreamFailed, 'The folder dialog failed');
    }
  }
}

/** Runs a program with no shell and resolves to its stdout; rejects with the exit code when it fails. */
export type Dialog = (file: string, args: string[]) => Promise<string>;

const runDialog: Dialog = async (file, args) => (await run(file, args, { timeout: 10 * 60_000 })).stdout;

/** The dialog programs a Linux desktop may have, in the order tried. */
const NO_DIALOG = 'No folder dialog is installed (zenity or kdialog): type the path instead';

/** Whether a program is on the PATH, found without running it. */
async function onPath(name: string, search = process.env.PATH ?? ''): Promise<boolean> {
  for (const dir of search.split(path.delimiter).filter(Boolean)) {
    try {
      await access(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Not in this folder.
    }
  }
  return false;
}

/**
 * The desktop's folder dialog through `zenity` or `kdialog`. Neither installed, or no desktop to show it on, and the
 * operator types the path. `kdialog` picks one folder at a time.
 */
export class LinuxFolderPicker implements FolderPicker {
  constructor(
    private readonly dialog: Dialog = runDialog,
    private readonly env: { display?: string; path?: string } = {},
  ) {}

  /** A display to open on and one of the two programs installed. */
  async available(): Promise<boolean> {
    const display = this.env.display ?? process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY;
    if (!display) return false;
    return (await onPath('zenity', this.env.path)) || (await onPath('kdialog', this.env.path));
  }

  async pick({ prompt = 'Choose one or more git repositories', multiple = true }: PickOptions = {}): Promise<string[]> {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && this.dialog === runDialog) {
      throw new ApiError(409, ErrorCode.InvalidState, NO_DIALOG);
    }
    const zenity = [
      '--file-selection',
      '--directory',
      `--title=${prompt}`,
      ...(multiple ? ['--multiple', '--separator=\n'] : []),
    ];
    for (const [file, args] of [
      ['zenity', zenity],
      ['kdialog', ['--getexistingdirectory', os.homedir(), '--title', prompt]],
    ] as const) {
      try {
        return (await this.dialog(file, [...args]))
          .split('\n')
          .map((line) => line.trim().replace(/(.)\/$/, '$1'))
          .filter(Boolean);
      } catch (error) {
        const { code, stderr } = error as { code?: unknown; stderr?: unknown };
        // A program that is not installed is skipped. A closed dialog exits 1 and says nothing; with a message, as when
        // there is no display to open on, the dialog failed.
        if (code === 'ENOENT') continue;
        if (code === 1 && !String(stderr ?? '').trim()) return [];
        throw new ApiError(502, ErrorCode.UpstreamFailed, 'The folder dialog failed');
      }
    }
    throw new ApiError(409, ErrorCode.InvalidState, NO_DIALOG);
  }
}

/** The folder picker for this machine's system. */
export function folderPicker(platform: NodeJS.Platform = process.platform): FolderPicker {
  return platform === 'linux' ? new LinuxFolderPicker() : new MacFolderPicker();
}
