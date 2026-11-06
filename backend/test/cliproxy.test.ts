import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIPROXY_KEY } from '../src/accounts/cliproxy.service';
import { KEYCHAIN, type Keychain } from '../src/keychain/keychain';
import { type AgentDaemon, api, converse, startAgentDaemon } from './agent-fixtures';

const KEY = 'sk-cliproxy-test';

const running: AgentDaemon[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function start(options: Parameters<typeof startAgentDaemon>[0] = {}) {
  const daemon = await startAgentDaemon(options);
  running.push(daemon);
  return daemon;
}

/** A stand-in for CLIProxy: `/v1/models` answers 200 to `KEY` only. */
async function fakeCliProxy(): Promise<string> {
  const server = createServer((req, res) => {
    const ok = req.url === '/v1/models' && req.headers.authorization === `Bearer ${KEY}`;
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { data: [{ id: 'claude-opus-5-5' }] } : { error: 'unauthorized' }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const hub = async (daemon: AgentDaemon) => (await api(daemon).get('/cliproxy')).body.data;

describe('CLIProxy as the Claude account hub', () => {
  it('is off with no key on a fresh install', async () => {
    const daemon = await start();
    expect(await hub(daemon)).toEqual({
      enabled: false,
      address: 'http://127.0.0.1:8317',
      has_key: false,
      status: 'no_key',
      status_detail: null,
      checked_at: null,
    });
  });

  it('takes only an address on this Mac', async () => {
    const daemon = await start();
    const remote = await api(daemon).patch('/settings', {
      cliproxy: { enabled: false, address: 'https://proxy.example.com' },
    });
    expect([remote.status, remote.body.error.code]).toEqual([400, 'validation_failed']);
    const local = await api(daemon).patch('/settings', {
      cliproxy: { enabled: false, address: 'http://localhost:9000' },
    });
    expect(local.status).toBe(200);
  });

  it('keeps the key in the Keychain, never in an answer, and checks it against CLIProxy', async () => {
    const daemon = await start();
    const address = await fakeCliProxy();
    await api(daemon).patch('/settings', { cliproxy: { enabled: false, address } });

    const wrong = await api(daemon).put('/cliproxy/key', { key: 'sk-wrong' });
    expect(wrong.body.data).toMatchObject({ has_key: true, status: 'refused' });
    const saved = await api(daemon).put('/cliproxy/key', { key: KEY });
    expect(saved.body.data).toMatchObject({ has_key: true, status: 'connected', status_detail: null });
    expect(JSON.stringify(saved.body)).not.toContain(KEY);
    expect(await daemon.app.get<Keychain>(KEYCHAIN).get(CLIPROXY_KEY)).toBe(KEY);

    await api(daemon).patch('/settings', { cliproxy: { enabled: false, address: 'http://127.0.0.1:1' } });
    const down = await api(daemon).post('/cliproxy/checks');
    expect(down.body.data).toMatchObject({
      status: 'unreachable',
      status_detail: 'Nothing answers at http://127.0.0.1:1',
    });
  });

  it('signs runs in through CLIProxy while on, and through the account again once off', async () => {
    const daemon = await start();
    const address = await fakeCliProxy();
    await api(daemon).put('/cliproxy/key', { key: KEY });
    await api(daemon).patch('/settings', { cliproxy: { enabled: true, address: `${address}/` } });

    await converse(daemon, daemon.createSession(), 'hello');
    const through = daemon.sdk.calls.at(-1)?.options.env;
    expect(through).toMatchObject({ ANTHROPIC_BASE_URL: address, ANTHROPIC_AUTH_TOKEN: KEY });
    // The account still lends its folder for the conversation and the MCP servers.
    expect(through?.CLAUDE_CONFIG_DIR).toBe(daemon.home);

    await api(daemon).patch('/settings', { cliproxy: { enabled: false, address } });
    await converse(daemon, daemon.createSession(), 'hello');
    const direct = daemon.sdk.calls.at(-1)?.options.env;
    expect(direct?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(direct?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('runs through CLIProxy under an account that is signed out, and leaves its usage alone', async () => {
    const daemon = await start();
    const address = await fakeCliProxy();
    const [account] = (await api(daemon).get('/agent-accounts')).body.data;
    await api(daemon).post(`/agent-accounts/${account.id}/logout`);
    await api(daemon).put('/cliproxy/key', { key: KEY });
    await api(daemon).patch('/settings', { cliproxy: { enabled: true, address } });

    daemon.sdk.script({
      rateLimit: {
        status: 'allowed',
        five_hour: { pct: 97, resetsInHours: 2 },
        seven_day: { pct: 50, resetsInHours: 48 },
      },
    });
    await converse(daemon, daemon.createSession(), 'usage');
    const after = (await api(daemon).get('/agent-accounts')).body.data[0];
    expect(after).toMatchObject({ signed_in: false, five_hour_pct: null });
  });

  it('refuses a run while on without a key, and turns off when the key is removed', async () => {
    const daemon = await start();
    await api(daemon).patch('/settings', { cliproxy: { enabled: true, address: 'http://127.0.0.1:8317' } });
    const sent = await api(daemon).post(`/sessions/${daemon.createSession()}/messages`, { text: 'hello' });
    expect([sent.status, sent.body.error.message]).toEqual([
      409,
      'CLIProxy has no API key: add one in Accounts & Usage',
    ]);
    await api(daemon).put('/cliproxy/key', { key: KEY });
    const removed = await api(daemon).delete('/cliproxy/key');
    expect(removed.body.data).toMatchObject({ enabled: false, has_key: false, status: 'no_key' });
    expect(await daemon.app.get<Keychain>(KEYCHAIN).get(CLIPROXY_KEY)).toBeNull();
  });
});
