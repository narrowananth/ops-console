import { accessSync, constants } from 'node:fs';
import path from 'node:path';

export type OpenPlan = { command: string; args: string[] } | { none: string };

function onPath(name: string, searchPath: string | undefined): boolean {
  return (searchPath ?? '').split(path.delimiter).some((dir) => {
    try {
      accessSync(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * How to open `url`: macOS runs `open`, Linux `xdg-open` or the browser command the operator named. `none` carries the
 * reason no browser can open here: no desktop session, or no `xdg-open`.
 */
export function openPlan(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  url: string;
  browser?: string;
}): OpenPlan {
  const { platform, env, url, browser } = input;
  if (platform !== 'linux') return { command: 'open', args: browser ? ['-a', browser, url] : [url] };
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { none: 'No desktop session found' };
  if (browser) return { command: browser, args: [url] };
  if (!onPath('xdg-open', env.PATH)) return { none: 'xdg-open is not installed' };
  return { command: 'xdg-open', args: [url] };
}
