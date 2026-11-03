import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { SdkUsageSource } from './accounts/usage-source';
import { AgentModule } from './agent/agent.module';
import { ClaudeAgentSdk } from './agent/agent-sdk';
import { McpConnectionTester } from './connections/connection-tester';
import { ConnectionsModule } from './connections/connections.module';
import { CliConnectorTools } from './connectors/connector-tools';
import { ConnectorsModule } from './connectors/connectors.module';
import { startDaemon } from './daemon';
import { DevtoolsModule } from './devtools/devtools.module';
import { adoptKeychainItems, otherVersionApps } from './keychain/handover';
import { LoginKeychain } from './keychain/keychain';
import { runMcpExec } from './mcp/launcher';
import { McpServersModule } from './mcp/mcp-servers.module';
import { SdkProbe } from './mcp/probe';
import { MonitorModule } from './monitor/monitor.module';
import { ReposModule } from './repos/repos.module';
import { runSetupMcp } from './terminals/setup-mcp';
import { TerminalsModule } from './terminals/terminals.module';
import { ScriptInstaller } from './updates/installer';
import { GithubReleases } from './updates/releases';
import { UpdatesModule } from './updates/updates.module';
import { WorkspaceModule } from './workspace/workspace.module';

const keychain = new LoginKeychain(process.env.OPS_CONSOLE_KEYCHAIN_SERVICE || undefined);

// `ops-console mcp-exec <name> -- <command>`: the launcher for a stdio server whose env vars the console holds.
if (process.argv[2] === 'mcp-exec') process.exit(await runMcpExec(process.argv.slice(3), keychain));

// `ops-console mcp-setup`: the MCP Server of the Dev tools setup agent.
if (process.argv[2] === 'mcp-setup') {
  await runSetupMcp(process.env);
  await new Promise(() => {});
}

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
const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : 'dev';
const dataDir = path.resolve(
  env.OPS_CONSOLE_DATA_DIR ?? path.join(homedir(), 'Library', 'Application Support', 'ops-console'),
);

/**
 * An installed version takes the Keychain items over from the version before it, in the background so the daemon
 * answers at once; its Keychain waits for the handover. `pnpm dev` hands its items over itself.
 */
function adoptOnUpdate(): Promise<unknown> {
  const versionDir = path.dirname(realpathSync(appDir));
  const self = realpathSync(process.execPath);
  if (version === 'dev' || process.platform !== 'darwin' || !self.startsWith(`${versionDir}/`)) {
    return Promise.resolve();
  }
  const log = (level: string, text: string) =>
    process.stdout.write(`${new Date().toISOString()} ${level} [keychain] ${text}\n`);
  mkdirSync(dataDir, { recursive: true });
  return adoptKeychainItems({
    self,
    previous: otherVersionApps(versionDir, path.relative(versionDir, self)),
    ownerFile: path.join(dataDir, 'keychain-owner.json'),
    script: path.join(appDir, 'keychain-handover.mjs'),
    service: 'ops-console',
    keychain,
  }).then(
    (moved) => moved > 0 && log('INFO', `moved ${moved} items to ${version}'s app`),
    (error: unknown) => log('WARN', `items stay with the previous version's app: ${(error as Error).message}`),
  );
}

const daemon = await startDaemon({
  dataDir,
  port: env.OPS_CONSOLE_PORT,
  version,
  keychain: new LoginKeychain(process.env.OPS_CONSOLE_KEYCHAIN_SERVICE || undefined, adoptOnUpdate()),
  uiDir: existsSync(uiDir) ? uiDir : null,
  migrationsDir: path.join(appDir, 'drizzle'),
  writeLog: (line) => process.stdout.write(`${line}\n`),
  modules: [
    AgentModule.forRoot({ sdk: new ClaudeAgentSdk(), usage: new SdkUsageSource() }),
    ReposModule.forRoot(),
    WorkspaceModule.forRoot(),
    MonitorModule.forRoot(),
    DevtoolsModule.forRoot(),
    TerminalsModule.forRoot(),
    ConnectionsModule.forRoot({ tester: new McpConnectionTester(version), launchDir: path.join(appDir, 'launch') }),
    ConnectorsModule.forRoot({ tools: new CliConnectorTools() }),
    UpdatesModule.forRoot({ releases: new GithubReleases(), installer: new ScriptInstaller(path.join(appDir, '..')) }),
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
