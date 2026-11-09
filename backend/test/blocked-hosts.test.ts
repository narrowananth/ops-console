import { afterEach, describe, expect, it } from 'vitest';
import { blockedHostsIn, coveredBy } from '../src/network/blocked-hosts';
import { type AgentDaemon, api, gate, startAgentDaemon, until } from './agent-fixtures';

describe('blockedHostsIn', () => {
  it('reads each refused host once, lowercase, in the order first seen', () => {
    const output = [
      'deny network-outbound Stamped.io:443 (host is not on the allow list)',
      'retrying…',
      'deny network-outbound loox.io:443 (host is not on the allow list)',
      'deny network-outbound stamped.io:443 (host is not on the allow list)',
    ].join('\n');
    expect(blockedHostsIn(output)).toEqual(['stamped.io', 'loox.io']);
  });

  it('reads a tool response that is an object, and ignores other text', () => {
    expect(
      blockedHostsIn({ stderr: 'deny network-outbound api.weglot.com:443 (host is not on the allow list)', code: 56 }),
    ).toEqual(['api.weglot.com']);
    expect(blockedHostsIn('ok')).toEqual([]);
    expect(blockedHostsIn('deny network-outbound 10.0.0.1:443 (host is not on the allow list)')).toEqual([]);
    expect(blockedHostsIn(undefined)).toEqual([]);
  });
});

describe('coveredBy', () => {
  it('matches a name exactly and a wildcard on subdomains only', () => {
    expect(coveredBy(['stamped.io'], 'stamped.io')).toBe(true);
    expect(coveredBy(['stamped.io'], 'api.stamped.io')).toBe(false);
    expect(coveredBy(['*.stamped.io'], 'api.stamped.io')).toBe(true);
    expect(coveredBy(['*.stamped.io'], 'stamped.io')).toBe(false);
  });
});

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

describe('a run is told which hosts the sandbox refused', () => {
  it('shows them on the run at once, turns it to needs-you, and drops one once it is allowed', async () => {
    const daemon = await startAgentDaemon();
    running.push(daemon);
    const hold = gate();
    daemon.sdk.script(
      {
        tool: 'Bash',
        input: { command: 'npx jest' },
        output:
          'deny network-outbound stamped.io:443 (host is not on the allow list)\ndeny network-outbound loox.io:443 (host is not on the allow list)',
      },
      { wait: hold.promise },
    );
    const id = daemon.createSession();
    await api(daemon).patch(`/sessions/${id}`, { access_mode: 'full' });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'review' });
    const read = async () =>
      (await api(daemon).get('/agent-runs')).body.data.find((r: { session: { id: string } }) => r.session.id === id);
    await until(read, (run) => run?.blocked_hosts.length === 2, 'the refused hosts');
    const run = await read();
    expect(run.blocked_hosts).toEqual(['stamped.io', 'loox.io']);
    expect(run.health).toBe('needs_you');
    expect(run.health_reason).toContain('stamped.io, loox.io');

    await api(daemon).post('/network-allowlist/domains', { domain: 'stamped.io' });
    expect((await read()).blocked_hosts).toEqual(['loox.io']);
    await api(daemon).post('/network-allowlist/domains', { domain: '*.loox.io' });
    expect((await read()).blocked_hosts).toEqual(['loox.io']);
    await api(daemon).post('/network-allowlist/domains', { domain: 'loox.io' });
    const after = await read();
    expect(after.blocked_hosts).toEqual([]);
    expect(after.health).toBe('on_track');
    hold.open();
  });

  it('forgets them when the next run starts', async () => {
    const daemon = await startAgentDaemon();
    running.push(daemon);
    daemon.sdk.script({
      tool: 'Bash',
      input: { command: 'curl x' },
      output: 'deny network-outbound stamped.io:443 (host is not on the allow list)',
    });
    const id = daemon.createSession();
    await api(daemon).patch(`/sessions/${id}`, { access_mode: 'full' });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'one' });
    await until(
      async () => (await api(daemon).get(`/sessions/${id}`)).body.data.state,
      (state) => state === 'idle',
      'the first run',
    );
    const read = async () => (await api(daemon).get(`/agent-runs/${id}`)).body.data.run;
    expect((await read()).blocked_hosts).toEqual(['stamped.io']);
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'two' });
    await until(
      async () => (await api(daemon).get(`/sessions/${id}`)).body.data.state,
      (state) => state === 'idle',
      'the second run',
    );
    expect((await read()).blocked_hosts).toEqual([]);
  });
});
