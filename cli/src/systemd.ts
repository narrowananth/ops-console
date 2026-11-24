import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { daemonEnv } from './daemon-env';
import { DAEMON_EXECUTABLE, DAEMON_SCRIPT, LOG_DIR, LOG_FILE, UNIT, UNIT_FILE } from './paths';

function systemctl(...args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`.trim();
  return { ok: result.status === 0, output };
}

/** Double-quoted for a unit file, with `%` doubled so systemd reads no specifier. */
function quote(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

/** An ExecStart word: `$` is doubled too, since systemd expands `$VAR` there. */
const arg = (text: string): string => quote(text.replaceAll('$', () => '$$'));

export type UnitInput = { executable: string; script: string; logFile: string; env: Record<string, string> };

/** The user service: restarted whenever the daemon exits, started at login, output appended to the log file. */
export function systemdUnit({ executable, script, logFile, env }: UnitInput): string {
  const environment = Object.entries(env)
    .map(([name, value]) => `Environment=${quote(`${name}=${value}`)}`)
    .join('\n');
  return `[Unit]
Description=Ops Console

[Service]
Type=simple
ExecStart=${arg(executable)} ${arg(script)}
${environment}
Restart=always
RestartSec=2
StandardOutput=append:${logFile.replaceAll('%', '%%')}
StandardError=append:${logFile.replaceAll('%', '%%')}

[Install]
WantedBy=default.target
`;
}

function unit(): string {
  return systemdUnit({ executable: DAEMON_EXECUTABLE, script: DAEMON_SCRIPT, logFile: LOG_FILE, env: daemonEnv() });
}

/** Why there is no user manager (no bus, no systemd, no systemctl), or `null` when there is one. */
function missingManager(): string | null {
  const probe = systemctl('show-environment');
  return probe.ok ? null : probe.output;
}

/**
 * Writes the unit pointing at `current`, enables it and starts it. With no systemd user manager it writes nothing and
 * starts nothing.
 */
export async function load(): Promise<{ ok: boolean; output: string }> {
  const missing = missingManager();
  if (missing !== null) {
    return {
      ok: false,
      output: `this login has no systemd user manager, which ops-console needs to run in the background (${missing || 'systemctl did not answer'})`,
    };
  }
  await mkdir(path.dirname(UNIT_FILE), { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(UNIT_FILE, unit());
  const reloaded = systemctl('daemon-reload');
  if (!reloaded.ok) return reloaded;
  await unload();
  return systemctl('enable', '--now', UNIT);
}

/**
 * Starts the daemon again on `current`. A unit that is not enabled, or whose text changed, is loaded again, since
 * systemd reads the unit file only on a reload.
 */
export async function restart(): Promise<{ ok: boolean; output: string }> {
  const enabled = systemctl('is-enabled', UNIT).ok;
  const current = (await readFile(UNIT_FILE, 'utf8').catch(() => null)) === unit();
  if (!enabled || !current) return load();
  return systemctl('restart', UNIT);
}

/** Stops the service and disables it, so it stays stopped across logins until the next `load`. */
export async function unload(): Promise<void> {
  systemctl('disable', '--now', UNIT);
}

export async function removeUnit(): Promise<void> {
  await rm(UNIT_FILE, { force: true });
  systemctl('daemon-reload');
}
