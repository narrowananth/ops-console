import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

export const BROWSER_OPTIONS = Symbol('BROWSER_OPTIONS');

export type BrowserOptions = {
  /** The Chrome executable; default `OPS_CONSOLE_CHROME_PATH`, else Google Chrome in /Applications. */
  chromePath?: string;
  /** Opens an address in the operator's own browser. */
  openExternal?: (url: string) => Promise<void>;
  /** A Session's Chrome exits after this long with no viewer and no agent call. */
  idleMs?: number;
};

export const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const DEFAULT_IDLE_MS = 10 * 60_000;

/** The Chrome to run, or null when none is installed. Checked per call, so installing Chrome needs no restart. */
export function findChrome(configured?: string): string | null {
  const path = configured ?? process.env.OPS_CONSOLE_CHROME_PATH ?? DEFAULT_CHROME;
  return existsSync(path) ? path : null;
}

const run = promisify(execFile);

export async function openInDefaultBrowser(url: string): Promise<void> {
  await run('open', [url]);
}
