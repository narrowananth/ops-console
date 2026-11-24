import { COMPILE_CACHE, DATA_DIR } from './paths';

/**
 * A service manager starts the daemon with a bare PATH and its own idea of HOME. The daemon gets the operator's PATH,
 * so it finds `claude`, and the data folder this CLI reads the runtime file from. A pool of 16 threads keeps a few
 * Keychain calls that wait for a password from holding every thread the daemon's files and DNS share.
 */
export function daemonEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    OPS_CONSOLE_DATA_DIR: DATA_DIR,
    UV_THREADPOOL_SIZE: '16',
    NODE_COMPILE_CACHE: COMPILE_CACHE,
  };
  if (process.env.OPS_CONSOLE_PORT) env.OPS_CONSOLE_PORT = process.env.OPS_CONSOLE_PORT;
  // A systemd user manager does not always know the desktop the operator logged in to; the folder dialog needs it.
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']) {
    const value = process.env[name];
    if (process.platform === 'linux' && value) env[name] = value;
  }
  return env;
}
