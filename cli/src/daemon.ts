import { readFile } from 'node:fs/promises';
import { healthSchema, type Runtime, runtimeSchema } from '@ops-console/shared';
import { z } from 'zod';
import { RUNTIME_FILE } from './paths';

const healthBodySchema = z.object({ data: healthSchema });

/** The running daemon, or `null` when no runtime file exists or the daemon does not answer health. */
export async function runningDaemon(): Promise<Runtime | null> {
  let runtime: Runtime;
  try {
    runtime = runtimeSchema.parse(JSON.parse(await readFile(RUNTIME_FILE, 'utf8')));
  } catch {
    return null;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/api/health`, {
      headers: { Authorization: `Bearer ${runtime.token}` },
      signal: AbortSignal.timeout(2000),
    });
    return response.ok && healthBodySchema.safeParse(await response.json()).success ? runtime : null;
  } catch {
    return null;
  }
}
