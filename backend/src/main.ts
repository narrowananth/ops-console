import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { SdkUsageSource } from './accounts/usage-source';
import { AgentModule } from './agent/agent.module';
import { ClaudeAgentSdk } from './agent/agent-sdk';
import { quietShadowedPrompt } from './agent/sdk-warnings';
import { BrowserModule } from './browser/browser.module';
import { McpConnectionTester } from './connections/connection-tester';
import { ConnectionsModule } from './connections/connections.module';
import { CliConnectorTools } from './connectors/connector-tools';
import { ConnectorsModule } from './connectors/connectors.module';
import { readGoogleClient } from './connectors/google-client';
import { startDaemon } from './daemon';
import { DevtoolsModule } from './devtools/devtools.module';
import { HealthWatchModule } from './health-watch/health-watch.module';
import { adoptKeychainItems, HandoverRefused, otherVersionApps } from './keychain/handover';
import { HandoverGate } from './keychain/handover-gate';
import { KeychainHandoverTracker } from './keychain/handover-state';
import { LoginKeychain } from './keychain/keychain';
import { KeychainWaitTracker } from './keychain/keychain-wait';
import { McpServersModule } from './mcp/mcp-servers.module';
import { SdkProbe } from './mcp/probe';
import { MonitorModule } from './monitor/monitor.module';
import { ProcessesModule } from './processes/processes.module';
import { ReposModule } from './repos/repos.module';
import { runSetupMcp } from './terminals/setup-mcp';
import { TerminalsModule } from './terminals/terminals.module';
import { ScriptInstaller } from './updates/installer';
import { GithubReleases } from './updates/releases';
import { UpdatesModule } from './updates/updates.module';
import { WorkspaceModule } from './workspace/workspace.module';

quietShadowedPrompt();

// Each Keychain call holds one libuv thread while the Mac waits for a password; the default pool has four.
process.env.UV_THREADPOOL_SIZE ??= '16';

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
    OPS_CONSOLE_GOOGLE_CLIENT_ID: z.string().optional(),
    OPS_CONSOLE_GOOGLE_CLIENT_SECRET: z.string().optional(),
    OPS_CONSOLE_PORT: z.coerce.number().int().min(0).max(65535).default(4545),
  })
  .parse(process.env);
const appDir = path.resolve(env.OPS_CONSOLE_APP_DIR ?? path.dirname(process.argv[1] ?? '.'));
const versionFile = path.join(appDir, '..', 'VERSION');
const uiDir = path.join(appDir, 'public');
const googleClient = readGoogleClient(env, path.join(appDir, 'google-client.json'));
const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : 'dev';
const dataDir = path.resolve(
  env.OPS_CONSOLE_DATA_DIR ?? path.join(homedir(), 'Library', 'Application Support', 'ops-console'),
);

/**
 * An installed daemon with no list of its keys yet asks its own app for them, once, in the background: later handovers
 * then read those keys directly instead of scanning the login keychain. Nothing waits for it.
 */
function listOwnedKeys(holdsItems: boolean): void {
  // After a handover that failed, the previous app still holds items this app cannot list.
  if (!holdsItems || keychain.manifest() !== null) return;
  execFile(
    process.execPath,
    [path.join(appDir, 'keychain-handover.mjs'), 'list', 'ops-console'],
    { encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 50 * 1024 * 1024 },
    (error, stdout) => {
      if (error) return;
      const keys = z.array(z.string()).safeParse(JSON.parse(stdout));
      if (keys.success) keychain.confirmManifest(keys.data);
    },
  );
}

const keychainWait = new KeychainWaitTracker();
const keychainHandover = new KeychainHandoverTracker();
const handoverGate = new HandoverGate();
const keychain = new LoginKeychain(process.env.OPS_CONSOLE_KEYCHAIN_SERVICE || undefined, handoverGate, {
  wait: keychainWait,
  manifestFile: path.join(dataDir, 'keychain-manifest.json'),
});

/**
 * An installed version takes the Keychain items over from the version before it, in the background so the daemon
 * answers at once; a Keychain call waits only for its own item. `pnpm dev` hands its items over itself.
 */
function adoptOnUpdate(handover: KeychainHandoverTracker): Promise<boolean> {
  const versionDir = path.dirname(realpathSync(appDir));
  const self = realpathSync(process.execPath);
  if (version === 'dev' || process.platform !== 'darwin' || !self.startsWith(`${versionDir}/`)) {
    return Promise.resolve(false);
  }
  const log = (level: string, text: string) =>
    process.stdout.write(`${new Date().toISOString()} ${level} [keychain] ${text}\n`);
  mkdirSync(dataDir, { recursive: true });
  return adoptKeychainItems({
    self,
    previous: otherVersionApps(versionDir, path.relative(versionDir, self)),
    versionsDir: path.dirname(versionDir),
    ownerFile: path.join(dataDir, 'keychain-owner.json'),
    script: path.join(appDir, 'keychain-handover.mjs'),
    service: 'ops-console',
    keychain: {
      set: (key, value) => keychain.moveIn(key, value),
      get: (key) => keychain.get(key),
      delete: (key) => keychain.delete(key),
    },
    gate: handoverGate,
    manifest: { keys: () => keychain.manifest(), confirm: () => keychain.confirmManifest() },
  }).then(
    (moved) => {
      if (moved > 0) log('INFO', `moved ${moved} items to ${version}'s app`);
      return true;
    },
    (error: unknown) => {
      if (error instanceof HandoverRefused) {
        handover.refuse(error.reason);
        log('WARN', `refused the handover, items stay with the previous version's app: ${error.reason}`);
      } else log('WARN', `items stay with the previous version's app: ${(error as Error).message}`);
      return false;
    },
  );
}

keychainHandover.begin();
void adoptOnUpdate(keychainHandover).then((holdsItems) => {
  handoverGate.finish();
  keychainHandover.finish();
  listOwnedKeys(holdsItems);
});

const daemon = await startDaemon({
  dataDir,
  port: env.OPS_CONSOLE_PORT,
  version,
  keychain,
  keychainWait,
  keychainHandover,
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
    BrowserModule.forRoot(),
    ProcessesModule.forRoot(),
    ConnectionsModule.forRoot({ tester: new McpConnectionTester(version), launchDir: path.join(appDir, 'launch') }),
    ConnectorsModule.forRoot({ tools: new CliConnectorTools(), googleClient }),
    UpdatesModule.forRoot({ releases: new GithubReleases(), installer: new ScriptInstaller(path.join(appDir, '..')) }),
    HealthWatchModule.forRoot(),
    McpServersModule.forRoot({
      probe: new SdkProbe(),
      launcher: env.OPS_CONSOLE_LAUNCHER ?? path.join(homedir(), '.ops-console', 'current', 'bin', 'ops-console'),
    }),
  ],
}).catch(() => process.exit(1));

/** A stop that takes longer than this ends the process: an update must not leave the console down for minutes. */
const STOP_DEADLINE_MS = 20_000;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    setTimeout(() => process.exit(1), STOP_DEADLINE_MS).unref();
    daemon.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
