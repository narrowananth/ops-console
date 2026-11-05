import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ErrorCode } from '@ops-console/shared';
import { ApiError } from '../common/errors';

const run = promisify(execFile);

export const FOLDER_PICKER = Symbol('FOLDER_PICKER');

/** The operating system's own folder dialog, opened on this machine. Tests replace it. */
export interface FolderPicker {
  /** The chosen folders, one or more; empty when the operator closes the dialog. */
  pick(): Promise<string[]>;
}

/** One folder path per line: a path can hold any character but a line break. */
const SCRIPT = [
  'tell application "System Events" to activate',
  'set picked to choose folder with prompt "Choose one or more git repositories" with multiple selections allowed',
  'set out to ""',
  'repeat with folder_ in picked',
  'set out to out & POSIX path of folder_ & linefeed',
  'end repeat',
  'return out',
];

/** The Finder's folder dialog through `osascript`. The daemon is local-only (ADR 0003), so the dialog is on the operator's screen. */
export class MacFolderPicker implements FolderPicker {
  async pick(): Promise<string[]> {
    if (process.platform !== 'darwin') {
      throw new ApiError(409, ErrorCode.InvalidState, 'The folder dialog needs macOS: type the path instead');
    }
    try {
      const { stdout } = await run(
        'osascript',
        SCRIPT.flatMap((line) => ['-e', line]),
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
