import type { DiskAccess, StartAtLogin } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiskAccessGate } from '../src/machine/disk-access';
import { MachineModule } from '../src/machine/machine.module';
import type { RunSandboxGate } from '../src/machine/run-sandbox-gate';
import type { StartAtLoginGate } from '../src/machine/start-at-login';
import { type AgentDaemon, api, startAgentDaemon } from './agent-fixtures';

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

async function start(options: Parameters<typeof MachineModule.forRoot>[0] = {}) {
  const daemon = await startAgentDaemon({ modules: [MachineModule.forRoot(options)] });
  running.push(daemon);
  return daemon;
}

/** Full Disk Access as the operator switches it on in System Settings; tests never open System Settings. */
class FakeDiskAccess implements DiskAccessGate {
  granted = false;
  opened = 0;

  async check(): Promise<DiskAccess> {
    return { granted: this.granted, app_path: '/Applications/Ops Console.app' };
  }

  async openSettings(): Promise<void> {
    this.opened += 1;
  }
}

/** launchd's agent as the operator switches it under App Background Activity; tests never open System Settings. */
class FakeStartAtLogin implements StartAtLoginGate {
  state: StartAtLogin = { on: false, dev_build: false };
  opened = 0;

  async check(): Promise<StartAtLogin> {
    return this.state;
  }

  async openSettings(): Promise<void> {
    this.opened += 1;
  }
}

describe('what the daemon needs from this Mac', () => {
  it('reports Full Disk Access off, opens System Settings, and reports it on once switched on', async () => {
    const diskAccess = new FakeDiskAccess();
    const daemon = await start({ diskAccess });
    const before = await api(daemon).get('/terminals/disk-access');
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual({ granted: false, app_path: '/Applications/Ops Console.app' });

    expect((await api(daemon).post('/terminals/disk-access/settings')).status).toBe(204);
    expect(diskAccess.opened).toBe(1);

    diskAccess.granted = true;
    const after = await api(daemon).get('/terminals/disk-access');
    expect(after.body.data).toEqual({ granted: true, app_path: '/Applications/Ops Console.app' });
  });

  it('reports Start at login off, opens Login Items, and reports it on once switched on', async () => {
    const startAtLogin = new FakeStartAtLogin();
    const daemon = await start({ startAtLogin });
    const before = await api(daemon).get('/terminals/start-at-login');
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual({ on: false, dev_build: false });

    expect((await api(daemon).post('/terminals/start-at-login/settings')).status).toBe(204);
    expect(startAtLogin.opened).toBe(1);

    startAtLogin.state = { on: true, dev_build: false };
    const after = await api(daemon).get('/terminals/start-at-login');
    expect(after.body.data).toEqual({ on: true, dev_build: false });
  });

  it('reports the Run sandbox as the gate finds it', async () => {
    const gate: RunSandboxGate = { check: async () => ({ status: 'unavailable', reason: 'sandbox-exec failed' }) };
    const daemon = await start({ runSandbox: gate });
    const read = await api(daemon).get('/terminals/run-sandbox');
    expect(read.body.data).toEqual({ status: 'unavailable', reason: 'sandbox-exec failed' });
  });

  it('serves the Keychain wait and handover with no other module loaded', async () => {
    const daemon = await start();
    expect((await api(daemon).get('/terminals/keychain-wait')).body.data).toEqual({
      waiting: false,
      since: null,
      pending: 0,
    });
    expect((await api(daemon).get('/terminals/keychain-handover')).body.data).toEqual({
      refused: false,
      reason: null,
    });
  });
});
