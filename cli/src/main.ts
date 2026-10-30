import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { runningDaemon } from './daemon';
import { load, unload } from './launchd';
import { BIN_LINK, DATA_DIR, INSTALL_DIR, LOG_DIR, LOG_FILE, PLIST, VERSION_ROOT } from './paths';

const START_TIMEOUT_MS = z.coerce
  .number()
  .int()
  .positive()
  .default(15_000)
  .parse(process.env.OPS_CONSOLE_START_TIMEOUT_MS);

const USAGE = `Usage: ops-console <command>

  start       Start the daemon and keep it running
  stop        Stop the daemon until the next start
  status      Show whether the daemon runs
  open        Open the console in the browser
  logs        Follow the daemon log
  update      Install the latest version
  uninstall   Remove ops-console, keeping data and logs
  --version   Print the installed version`;

async function start(): Promise<number> {
  const running = await runningDaemon();
  if (running) {
    console.log(`ops-console is already running (pid ${running.pid}, port ${running.port}).`);
    return 0;
  }
  return launch();
}

async function launch(): Promise<number> {
  const loaded = await load();
  if (!loaded.ok) {
    console.error(`launchctl could not load ${PLIST}: ${loaded.output}`);
    return 1;
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const running = await runningDaemon();
    if (running) {
      console.log(
        `ops-console ${running.version} is running on http://127.0.0.1:${running.port} (pid ${running.pid}).`,
      );
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  unload();
  console.error(
    `The daemon did not answer within ${Math.round(START_TIMEOUT_MS / 1000)} seconds. Last lines of ${LOG_FILE}:`,
  );
  console.error(await logTail(20));
  return 1;
}

async function logTail(lines: number): Promise<string> {
  try {
    return (await readFile(LOG_FILE, 'utf8')).trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log yet)';
  }
}

async function stop(): Promise<number> {
  unload();
  console.log('ops-console stopped.');
  return 0;
}

async function status(): Promise<number> {
  const running = await runningDaemon();
  if (!running) {
    console.log('stopped');
    return 3;
  }
  console.log(`running
pid      ${running.pid}
version  ${running.version}
port     ${running.port}
health   ok`);
  return 0;
}

async function open(): Promise<number> {
  const running = await runningDaemon();
  if (!running) {
    console.error('The daemon is not running. Run `ops-console start`.');
    return 1;
  }
  const url = `http://127.0.0.1:${running.port}/#token=${running.token}`;
  console.log(`Opening http://127.0.0.1:${running.port}`);
  return spawnSync('open', [url], { stdio: 'inherit' }).status ?? 1;
}

function logs(): Promise<number> {
  const tail = spawn('tail', ['-n', '100', '-F', LOG_FILE], { stdio: 'inherit' });
  return new Promise((resolve) => tail.on('exit', (code) => resolve(code ?? 0)));
}

async function update(): Promise<number> {
  const wasRunning = (await runningDaemon()) !== null;
  const env = { ...process.env };
  delete env.OPS_CONSOLE_VERSION;
  const installed = spawnSync('sh', [path.join(VERSION_ROOT, 'install.sh')], { stdio: 'inherit', env });
  if (installed.status !== 0) return installed.status ?? 1;
  if (!wasRunning) return 0;
  unload();
  return launch();
}

async function uninstall(): Promise<number> {
  unload();
  await rm(PLIST, { force: true });
  await rm(INSTALL_DIR, { recursive: true, force: true });
  if ((await lstat(BIN_LINK).catch(() => null))?.isSymbolicLink()) await rm(BIN_LINK);
  console.log(`ops-console removed. Left in place:
  data  ${DATA_DIR}
  logs  ${LOG_DIR}`);
  return 0;
}

function version(): number {
  const file = path.join(VERSION_ROOT, 'VERSION');
  console.log(existsSync(file) ? readFileSync(file, 'utf8').trim() : 'dev');
  return 0;
}

const commands: Record<string, () => Promise<number> | number> = {
  start,
  stop,
  status,
  open,
  logs,
  update,
  uninstall,
  '--version': version,
};

const command = commands[process.argv[2] ?? ''];
if (command) {
  process.exitCode = await command();
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
