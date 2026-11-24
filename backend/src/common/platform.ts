import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Where the daemon keeps its data when `OPS_CONSOLE_DATA_DIR` names none: Application Support on macOS, the XDG data
 * folder on Linux.
 */
export function defaultDataDir(
  options: { home?: string; platform?: NodeJS.Platform; xdgDataHome?: string | undefined } = {},
): string {
  const home = options.home ?? homedir();
  if ((options.platform ?? process.platform) === 'linux') {
    const xdg = 'xdgDataHome' in options ? options.xdgDataHome : process.env.XDG_DATA_HOME;
    return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share'), 'ops-console');
  }
  return path.join(home, 'Library', 'Application Support', 'ops-console');
}

/** The program that opens a URL or folder in the operator's default application: `open` on macOS, `xdg-open` elsewhere. */
export function openProgram(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'open' : 'xdg-open';
}
