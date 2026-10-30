import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CURRENT_LAUNCHER, DATA_DIR, LABEL, LOG_DIR, LOG_FILE, PLIST } from './paths';

const domain = `gui/${process.getuid?.() ?? 0}`;
const service = `${domain}/${LABEL}`;

function launchctl(...args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/**
 * launchd starts agents with a bare PATH and its own idea of HOME. The daemon gets the operator's PATH, so
 * it finds `claude`, and the data folder this CLI reads the runtime file from.
 */
function daemonEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', OPS_CONSOLE_DATA_DIR: DATA_DIR };
  if (process.env.OPS_CONSOLE_PORT) env.OPS_CONSOLE_PORT = process.env.OPS_CONSOLE_PORT;
  return env;
}

function plist(): string {
  const env = Object.entries(daemonEnv())
    .map(([name, value]) => `      <key>${name}</key>\n      <string>${xmlEscape(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(CURRENT_LAUNCHER)}</string>
      <string>daemon</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(LOG_FILE)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(LOG_FILE)}</string>
  </dict>
</plist>
`;
}

function xmlEscape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Writes the plist pointing at `current`, enables the agent and bootstraps it in the GUI domain. */
export async function load(): Promise<{ ok: boolean; output: string }> {
  await mkdir(path.dirname(PLIST), { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(PLIST, plist());
  unload();
  launchctl('enable', service);
  return launchctl('bootstrap', domain, PLIST);
}

/** Boots the agent out; it stays stopped across logins until the next `load`. */
export function unload(): void {
  launchctl('bootout', service);
  launchctl('disable', service);
}
