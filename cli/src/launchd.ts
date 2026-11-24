import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { daemonEnv } from './daemon-env';
import { DAEMON_EXECUTABLE, DAEMON_SCRIPT, LABEL, LOG_DIR, LOG_FILE, PLIST } from './paths';

const domain = `gui/${process.getuid?.() ?? 0}`;
const service = `${domain}/${LABEL}`;
/** launchd drops a job some time after `bootout` returns: as long as the daemon takes to stop, and a moment more. */
const BOOTOUT_TIMEOUT_MS = 15_000;

function launchctl(...args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
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
      <string>${xmlEscape(DAEMON_EXECUTABLE)}</string>
      <string>${xmlEscape(DAEMON_SCRIPT)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
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
  await unload();
  launchctl('enable', service);
  return launchctl('bootstrap', domain, PLIST);
}

/**
 * Starts the daemon again on `current`. Launchd stops it with SIGTERM and starts it from the same job, so one start
 * follows one stop. A job that is not loaded, or whose plist changed, is loaded again, since launchd reads the plist
 * only when it loads the job.
 */
export async function restart(): Promise<{ ok: boolean; output: string }> {
  const loaded = launchctl('print', service).ok;
  const current = (await readFile(PLIST, 'utf8').catch(() => null)) === plist();
  if (!loaded || !current) return load();
  return launchctl('kickstart', '-k', service);
}

/**
 * Boots the agent out and waits until launchd has dropped it: a `bootstrap` before then fails with
 * `Bootstrap failed: 5: Input/output error`. It stays stopped across logins until the next `load`.
 */
export async function unload(): Promise<void> {
  launchctl('bootout', service);
  const deadline = Date.now() + BOOTOUT_TIMEOUT_MS;
  while (launchctl('print', service).ok && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  launchctl('disable', service);
}

export async function removeUnit(): Promise<void> {
  await rm(PLIST, { force: true });
}
