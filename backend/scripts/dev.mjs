// `pnpm dev` for the backend: tsx watching src/main.ts on port 4556, data in .data, Keychain items under the
// service `ops-console-dev`, so it runs beside the installed app (4545, `ops-console`) without touching its data.
//
// On macOS the daemon runs as `.data/Ops Console (dev).app`, a copy of this Node in an app bundle, and launchd
// starts it. macOS then asks for Full Disk Access for Ops Console (dev) itself, as it does for the installed app,
// instead of lending the daemon the permissions of the terminal or editor that ran `pnpm dev`. The Keychain items
// the console keeps move to each new build of the app, so it reads them without asking. Its log is followed here;
// Ctrl+C stops it. Elsewhere, or with OPS_CONSOLE_DEV_INLINE=1, tsx runs in this terminal.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildAppBundle } from '../../scripts/app-bundle.mjs';
import { consoleAccounts } from './keychain-handover.mjs';

const backend = path.resolve(import.meta.dirname, '..');
const data = path.join(backend, '.data');
const tsx = path.join(backend, 'node_modules/tsx/dist/cli.mjs');
const env = {
  OPS_CONSOLE_APP_DIR: '.',
  OPS_CONSOLE_DATA_DIR: '.data',
  OPS_CONSOLE_PORT: '4556',
  OPS_CONSOLE_KEYCHAIN_SERVICE: 'ops-console-dev',
  OPS_CONSOLE_LAUNCHER: path.join(backend, 'scripts/dev-launcher.sh'),
};

if (process.platform !== 'darwin' || process.env.OPS_CONSOLE_DEV_INLINE === '1') {
  const child = spawn(process.execPath, [tsx, 'watch', 'src/main.ts'], {
    cwd: backend,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  await runAsApp();
}

async function runAsApp() {
  const name = 'Ops Console (dev)';
  const label = 'dev.ops-console.dev';
  const domain = `gui/${process.getuid()}`;
  const plistFile = path.join(data, `${label}.plist`);
  const log = path.join(data, 'dev.log');
  const launchctl = (...args) => spawnSync('launchctl', args, { encoding: 'utf8' });

  await mkdir(data, { recursive: true });
  const executable = await devApp(name, label);
  await writeFile(plistFile, plist({ label, executable, log }));
  await chmod(plistFile, 0o600);
  await writeFile(log, '');
  launchctl('bootout', `${domain}/${label}`);
  const started = launchctl('bootstrap', domain, plistFile);
  if (started.status !== 0) {
    console.error(`launchd did not start ${name}: ${`${started.stdout}${started.stderr}`.trim()}`);
    process.exit(1);
  }
  console.log(`${name} started by launchd; macOS asks for its permissions under that name.`);

  const file = await open(log, 'r');
  let offset = 0;
  const follow = async () => {
    const { size } = await stat(log);
    if (size <= offset) return;
    const { buffer, bytesRead } = await file.read(Buffer.alloc(size - offset), 0, size - offset, offset);
    offset += bytesRead;
    process.stdout.write(buffer.subarray(0, bytesRead));
  };
  const stop = (message, code) => {
    clearInterval(timer);
    clearInterval(watchdog);
    launchctl('bootout', `${domain}/${label}`);
    follow()
      .catch(() => {})
      .finally(() => {
        if (message) console.error(message);
        process.exit(code);
      });
  };
  const timer = setInterval(() => follow().catch(() => {}), 200);
  // tsx watch never exits on its own; when it does, say so instead of following a log no one writes.
  const watchdog = setInterval(() => {
    const job = launchctl('list', label);
    if (job.status === 0 && /"PID" = \d+;/.test(job.stdout)) return;
    const status = /"LastExitStatus" = (-?\d+);/.exec(job.stdout)?.[1] ?? 'unknown';
    stop(`${name} exited (status ${status}).`, 1);
  }, 2000);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(null, 0));
}

/**
 * The app around this Node, built again only when the Node changes: a new build means macOS asks for Full Disk
 * Access again. The Keychain items move from whichever program holds them (the last build, or this Node for items
 * written inline) to the app before it starts.
 */
async function devApp(name, id) {
  const app = path.join(data, `${name}.app`);
  const executable = path.join(app, 'Contents', 'MacOS', name);
  const stampFile = path.join(data, 'dev-app.json');
  const ownerFile = path.join(data, 'dev-keychain.json');
  const { size, mtimeMs } = await stat(process.execPath);
  const stamp = JSON.stringify({ node: process.execPath, version: process.version, size, mtimeMs });
  const built = (await readFile(stampFile, 'utf8').catch(() => null)) === stamp && existsSync(executable);
  const owner = await readFile(ownerFile, 'utf8').catch(() => null);
  if (built && owner === stamp) return executable;

  const staging = path.join(data, '.next-app');
  let fresh = executable;
  if (!built) {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging);
    await buildAppBundle({ node: process.execPath, dir: staging, name, id });
    fresh = path.join(staging, `${name}.app`, 'Contents', 'MacOS', name);
  }
  if (owner !== stamp) {
    handOverKeychain(owner !== null && existsSync(executable) ? executable : process.execPath, fresh);
    await writeFile(ownerFile, stamp);
  }
  if (!built) {
    await rm(app, { recursive: true, force: true });
    await rename(path.join(staging, `${name}.app`), app);
    await rm(staging, { recursive: true, force: true });
    await writeFile(stampFile, stamp);
  }
  return executable;
}

/** Moves the console's Keychain items from `from` to `to`; on a failed `put` they go back to `from`. */
function handOverKeychain(from, to) {
  const script = path.join(backend, 'scripts/keychain-handover.mjs');
  const run = (program, mode, input) => {
    const result = spawnSync(program, [script, mode, env.OPS_CONSOLE_KEYCHAIN_SERVICE], {
      cwd: backend,
      input,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`${mode} failed: ${result.stderr.trim().split('\n').at(-1)}`);
    return result.stdout;
  };
  if (consoleAccounts(env.OPS_CONSOLE_KEYCHAIN_SERVICE).length === 0) return;
  const secrets = run(from, 'take', '');
  try {
    run(to, 'put', secrets);
  } catch (error) {
    run(from, 'put', secrets);
    throw error;
  }
  console.log(`Moved ${Object.keys(JSON.parse(secrets)).length} Keychain items to the dev app.`);
}

/** A launchd job with no KeepAlive: it runs while `pnpm dev` does. */
function plist({ label, executable, log }) {
  const string = (value) =>
    `<string>${value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`;
  const vars = Object.entries({ PATH: process.env.PATH ?? '/usr/bin:/bin', ...env })
    .map(([key, value]) => `      <key>${key}</key>\n      ${string(value)}`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${string(label)}
    <key>ProgramArguments</key>
    <array>
      ${string(executable)}
      ${string(tsx)}
      <string>watch</string>
      <string>src/main.ts</string>
    </array>
    <key>WorkingDirectory</key>
    ${string(backend)}
    <key>EnvironmentVariables</key>
    <dict>
${vars}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    ${string(log)}
    <key>StandardErrorPath</key>
    ${string(log)}
  </dict>
</plist>
`;
}
