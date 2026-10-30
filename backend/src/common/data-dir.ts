import { chmod, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Runtime } from '@ops-console/shared';

export const DATA_DIR = Symbol('DATA_DIR');

/**
 * Takes `daemon.lock` in the data folder for this process. A lock whose pid still runs means another daemon
 * owns the folder; a lock whose pid is gone is left from a crash and is taken over.
 */
export async function lockDataDir(dataDir: string): Promise<() => Promise<void>> {
  const file = path.join(dataDir, 'daemon.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return () => rm(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number.parseInt(await readFile(file, 'utf8'), 10);
      if (Number.isInteger(holder) && isRunning(holder)) {
        throw new Error(`another daemon (pid ${holder}) is already running on ${dataDir}`);
      }
      await rm(file, { force: true });
    }
  }
  throw new Error(`could not take ${file}`);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The runtime file holds the session token, so only the operator may read it. */
export async function writeRuntimeFile(dataDir: string, runtime: Runtime): Promise<() => Promise<void>> {
  const file = path.join(dataDir, 'runtime.json');
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
  return () => rm(file, { force: true });
}
