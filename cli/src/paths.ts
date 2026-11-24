import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'dev.ops-console';
export const UNIT = 'ops-console.service';

/** An XDG folder: the variable when it is an absolute path, as the spec requires, else the default under home. */
function xdg(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  return value && path.isAbsolute(value) ? value : fallback;
}

/** Where the console keeps its files on `platform`: Linux follows the XDG folders, every other system is macOS. */
export function platformPaths(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv) {
  const installDir = path.join(home, '.ops-console');
  const current = path.join(installDir, 'current');
  const linux = platform === 'linux';
  const logDir = linux
    ? path.join(xdg(env, 'XDG_STATE_HOME', path.join(home, '.local', 'state')), 'ops-console')
    : path.join(home, 'Library', 'Logs', 'ops-console');
  const defaultData = linux
    ? path.join(xdg(env, 'XDG_DATA_HOME', path.join(home, '.local', 'share')), 'ops-console')
    : path.join(home, 'Library', 'Application Support', 'ops-console');
  return {
    installDir,
    /** The daemon runs as this app on macOS, so macOS lists it as Ops Console when the operator grants it access. */
    daemonExecutable: linux
      ? path.join(current, 'node', 'bin', 'node')
      : path.join(current, 'Ops Console.app', 'Contents', 'MacOS', 'Ops Console'),
    daemonScript: path.join(current, 'app', 'main.js'),
    plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    unitFile: path.join(xdg(env, 'XDG_CONFIG_HOME', path.join(home, '.config')), 'systemd', 'user', UNIT),
    dataDir: env.OPS_CONSOLE_DATA_DIR ?? defaultData,
    logDir,
    logFile: path.join(logDir, 'daemon.log'),
  };
}

const paths = platformPaths(process.platform, homedir(), process.env);

export const INSTALL_DIR = paths.installDir;
/** Node keeps compiled code here, so the daemon's 6 MB bundle is not parsed again on every start. */
export const COMPILE_CACHE = path.join(INSTALL_DIR, 'compile-cache');
export const DAEMON_EXECUTABLE = paths.daemonExecutable;
export const DAEMON_SCRIPT = paths.daemonScript;
export const BIN_LINK = path.join(homedir(), '.local', 'bin', 'ops-console');
export const PLIST = paths.plist;
export const UNIT_FILE = paths.unitFile;
export const DATA_DIR = paths.dataDir;
export const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
export const LOG_DIR = paths.logDir;
export const LOG_FILE = paths.logFile;

/** The installed version folder: `cli/ops-console.js` sits one level below it. */
export const VERSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
