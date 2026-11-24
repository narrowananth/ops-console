import type { KeychainAvailability } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionsModule } from '../src/connections/connections.module';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import type { Keychain } from '../src/keychain/keychain';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { ReposModule } from '../src/repos/repos.module';
import { TerminalsModule } from '../src/terminals/terminals.module';
import { type AgentDaemon, api, startAgentDaemon } from './agent-fixtures';
import { FakeConnectionTester } from './fakes/connection-tester';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeProbe } from './fakes/probe';

const running: AgentDaemon[] = [];
/** The modules the Terminals module needs beside it. */
const modules = () => [
  McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console/bin/ops-console' }),
  ConnectionsModule.forRoot({ tester: new FakeConnectionTester(), launchDir: '/opt/ops-console/app/launch' }),
  ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
  TerminalsModule.forRoot(),
];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

describe('Keychain availability', () => {
  /** A Keychain that cannot reach a Secret Service, as on a Linux login with no keyring. */
  class NoSecretService implements Keychain {
    async set(): Promise<void> {}
    async get(): Promise<string | null> {
      return null;
    }
    async delete(): Promise<void> {}
    async availability(): Promise<KeychainAvailability> {
      return { available: false, reason: 'no Secret Service answered: no D-Bus session', store: 'secret_service' };
    }
  }

  it('says whether secrets can be stored and why not (Behavior 16)', async () => {
    const daemon = await startAgentDaemon({ keychain: new NoSecretService(), modules: modules() });
    running.push(daemon);
    const read = await api(daemon).get('/terminals/keychain');
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual({
      available: false,
      reason: 'no Secret Service answered: no D-Bus session',
      store: 'secret_service',
    });
  });

  it('is always available where the Keychain has no check of its own', async () => {
    const daemon = await startAgentDaemon({ modules: modules() });
    running.push(daemon);
    const read = await api(daemon).get('/terminals/keychain');
    expect(read.body.data).toEqual({ available: true, reason: null, store: 'keychain' });
  });
});

describe('the folder dialog route', () => {
  it('says the dialog is available where the picker has no check of its own', async () => {
    const daemon = await startAgentDaemon({ modules: [ReposModule.forRoot({ picker: { pick: async () => [] } })] });
    running.push(daemon);
    const read = await api(daemon).get('/repos/folder-dialog');
    expect(read.status).toBe(200);
    expect(read.body.data).toEqual({ available: true });
  });

  it('says it is not when the picker cannot open one (Behavior 29)', async () => {
    const picker = { pick: async () => [] as string[], available: async () => false };
    const daemon = await startAgentDaemon({ modules: [ReposModule.forRoot({ picker })] });
    running.push(daemon);
    const read = await api(daemon).get('/repos/folder-dialog');
    expect(read.body.data).toEqual({ available: false });
  });
});
