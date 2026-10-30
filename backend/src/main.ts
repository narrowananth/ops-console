import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { SdkUsageSource } from './accounts/usage-source';
import { AgentModule } from './agent/agent.module';
import { ClaudeAgentSdk } from './agent/agent-sdk';
import { CliConnectorTools } from './connectors/connector-tools';
import { ConnectorsModule } from './connectors/connectors.module';
import { startDaemon } from './daemon';
import { LoginKeychain } from './keychain/keychain';
import { runMcpExec } from './mcp/launcher';
import { McpServersModule } from './mcp/mcp-servers.module';
import { SdkProbe } from './mcp/probe';

// `ops-console mcp-exec <name> -- <command>`: the launcher for a stdio server whose env vars the console holds.
if (process.argv[2] === 'mcp-exec') process.exit(await runMcpExec(process.argv.slice(3), new LoginKeychain()));

const env = z
  .object({
    OPS_CONSOLE_APP_DIR: z.string().optional(),
    OPS_CONSOLE_DATA_DIR: z.string().optional(),
    OPS_CONSOLE_LAUNCHER: z.string().optional(),
    OPS_CONSOLE_PORT: z.coerce.number().int().min(0).max(65535).default(4545),
  })
  .parse(process.env);
const appDir = path.resolve(env.OPS_CONSOLE_APP_DIR ?? path.dirname(process.argv[1] ?? '.'));
const versionFile = path.join(appDir, '..', 'VERSION');
const uiDir = path.join(appDir, 'public');

const daemon = await startDaemon({
  dataDir: path.resolve(
    env.OPS_CONSOLE_DATA_DIR ?? path.join(homedir(), 'Library', 'Application Support', 'ops-console'),
  ),
  port: env.OPS_CONSOLE_PORT,
  version: existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : 'dev',
  uiDir: existsSync(uiDir) ? uiDir : null,
  migrationsDir: path.join(appDir, 'drizzle'),
  writeLog: (line) => process.stdout.write(`${line}\n`),
  modules: [
    AgentModule.forRoot({ sdk: new ClaudeAgentSdk(), usage: new SdkUsageSource() }),
    ConnectorsModule.forRoot({ tools: new CliConnectorTools() }),
    McpServersModule.forRoot({
      probe: new SdkProbe(),
      launcher: env.OPS_CONSOLE_LAUNCHER ?? path.join(homedir(), '.ops-console', 'current', 'bin', 'ops-console'),
    }),
  ],
}).catch(() => process.exit(1));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    daemon.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
