import type { WsEvent } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionsModule } from '../src/connections/connections.module';
import { ConnectorsModule } from '../src/connectors/connectors.module';
import { KeychainHandoverTracker } from '../src/keychain/handover-state';
import { McpServersModule } from '../src/mcp/mcp-servers.module';
import { TerminalsModule } from '../src/terminals/terminals.module';
import { type AgentDaemon, api, listen, startAgentDaemon, until } from './agent-fixtures';
import { FakeConnectionTester } from './fakes/connection-tester';
import { FakeConnectorTools } from './fakes/connector-tools';
import { FakeProbe } from './fakes/probe';

const REASON = 'its bundle fails `codesign --verify --strict`: a sealed resource is missing or invalid';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

async function start(handover = new KeychainHandoverTracker()) {
  const daemon = await startAgentDaemon({
    keychainHandover: handover,
    modules: [
      McpServersModule.forRoot({ probe: new FakeProbe(), launcher: '/opt/ops-console/bin/ops-console' }),
      ConnectionsModule.forRoot({ tester: new FakeConnectionTester(), launchDir: '/opt/ops-console/app/launch' }),
      ConnectorsModule.forRoot({ tools: new FakeConnectorTools() }),
      TerminalsModule.forRoot(),
    ],
  });
  running.push(daemon);
  return { daemon, handover };
}

const stateOf = async (daemon: AgentDaemon) => (await api(daemon).get('/terminals/keychain-handover')).body.data;
const refusals = (events: WsEvent[]) =>
  events.flatMap((event) => (event.event === 'keychain.handover_refused' ? [event.data] : []));

describe('Keychain handover refusal', () => {
  it('reads as not refused on a start whose handover went through, and on every fresh start (Behavior 1, 8)', async () => {
    const { daemon } = await start();
    expect(await stateOf(daemon)).toEqual({ refused: false, reason: null });
  });

  it('reports the reason once it is set, tells every open browser once, and a reload reads it again (Behavior 9, 10)', async () => {
    const { daemon, handover } = await start();
    const first = await listen(daemon);
    const second = await listen(daemon);

    handover.refuse(REASON);
    handover.refuse('a later reason is ignored: the refusal is set once');

    expect(await stateOf(daemon)).toEqual({ refused: true, reason: REASON });
    await until(
      () => refusals(first.events),
      (heard) => heard.length >= 1,
      'keychain.handover_refused',
    );
    await until(
      () => refusals(second.events),
      (heard) => heard.length >= 1,
      'keychain.handover_refused in the second browser',
    );
    expect(refusals(first.events)).toEqual([{ refused: true, reason: REASON }]);
    expect(refusals(second.events)).toEqual([{ refused: true, reason: REASON }]);
  });
});
