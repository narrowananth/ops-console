import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = homedir();

export const LABEL = 'dev.ops-console';
export const INSTALL_DIR = path.join(home, '.ops-console');
export const CURRENT_LAUNCHER = path.join(INSTALL_DIR, 'current', 'bin', 'ops-console');
export const BIN_LINK = path.join(home, '.local', 'bin', 'ops-console');
export const PLIST = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
export const DATA_DIR =
  process.env.OPS_CONSOLE_DATA_DIR ?? path.join(home, 'Library', 'Application Support', 'ops-console');
export const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
export const LOG_DIR = path.join(home, 'Library', 'Logs', 'ops-console');
export const LOG_FILE = path.join(LOG_DIR, 'daemon.log');

/** The installed version folder: `cli/ops-console.js` sits one level below it. */
export const VERSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
