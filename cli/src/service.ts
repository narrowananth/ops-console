import * as launchd from './launchd';
import { PLIST, UNIT_FILE } from './paths';
import * as systemd from './systemd';

export type Service = {
  /** The tool that runs the daemon, for messages. */
  manager: string;
  /** The plist or unit file the manager reads. */
  unitFile: string;
  load(): Promise<{ ok: boolean; output: string }>;
  restart(): Promise<{ ok: boolean; output: string }>;
  unload(): Promise<void>;
  removeUnit(): Promise<void>;
};

/** launchd on macOS, a systemd user service on Linux. */
export const service: Service =
  process.platform === 'linux'
    ? { manager: 'systemctl', unitFile: UNIT_FILE, ...systemd }
    : { manager: 'launchctl', unitFile: PLIST, ...launchd };
