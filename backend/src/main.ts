import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { startDaemon } from './daemon';

const env = z
  .object({
    OPS_CONSOLE_APP_DIR: z.string().optional(),
    OPS_CONSOLE_DATA_DIR: z.string().optional(),
    OPS_CONSOLE_PORT: z.coerce.number().int().min(0).max(65535).default(4545),
  })
  .parse(process.env);
const appDir = path.resolve(env.OPS_CONSOLE_APP_DIR ?? path.dirname(process.argv[1] ?? '.'));
const versionFile = path.join(appDir, '..', 'VERSION');
const uiDir = path.join(appDir, 'public');

const daemon = await startDaemon({
  dataDir: env.OPS_CONSOLE_DATA_DIR ?? path.join(homedir(), 'Library', 'Application Support', 'ops-console'),
  port: env.OPS_CONSOLE_PORT,
  version: existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : 'dev',
  uiDir: existsSync(uiDir) ? uiDir : null,
  migrationsDir: path.join(appDir, 'drizzle'),
  writeLog: (line) => process.stdout.write(`${line}\n`),
}).catch(() => process.exit(1));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    daemon.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
