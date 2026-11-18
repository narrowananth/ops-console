import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { LoopbackGoogleAuth } from '../src/connectors/google-auth';
import { runGoogleBridge } from '../src/mcp/google-bridge';
import { FakeGoogle } from './fakes/google';

const open: FakeGoogle[] = [];
afterEach(async () => {
  for (const google of open.splice(0)) await google.close();
});

/** Signs in on the fake Google and returns the env the console's launcher would hand the bridge. */
async function signedIn(options: { sse?: boolean } = {}) {
  const google = await FakeGoogle.start();
  open.push(google);
  google.sse = options.sse ?? false;
  const auth = new LoopbackGoogleAuth(google.client, google.endpoints);
  const { refreshToken } = await auth.signIn(['openid'], new AbortController().signal, (url) => void google.visit(url));
  const env = {
    GOOGLE_CLIENT_ID: google.client.clientId,
    GOOGLE_CLIENT_SECRET: google.client.clientSecret,
    GOOGLE_REFRESH_TOKEN: refreshToken,
  };
  return { google, env, tokenUrl: google.endpoints.token };
}

type Reply = { id: number; result?: { tools?: unknown[]; serverInfo?: unknown }; error?: { message: string } };

/** Starts the bridge as Claude Code would: one message at a time, each answered before the next. */
function session(url: string, env: Record<string, string>, tokenUrl?: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const log = new PassThrough();
  const replies: Reply[] = [];
  const waiting = new Map<number, (reply: Reply) => void>();
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += String(chunk);
    const rows = buffer.split('\n');
    buffer = rows.pop() ?? '';
    for (const row of rows.filter(Boolean)) {
      const reply = JSON.parse(row) as Reply;
      replies.push(reply);
      waiting.get(reply.id)?.(reply);
    }
  });
  const done = runGoogleBridge(url, env, input, output, log, tokenUrl);
  return {
    replies,
    notify: (message: object) => void input.write(`${JSON.stringify(message)}\n`),
    ask: (message: { id: number }) =>
      new Promise<Reply>((resolve) => {
        waiting.set(message.id, resolve);
        input.write(`${JSON.stringify(message)}\n`);
      }),
    async end() {
      input.end();
      const code = await done;
      return { code, log: String(log.read() ?? '') };
    },
  };
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

describe('the Google bridge', () => {
  it("relays a session to Google with one minted token, and keeps Google's session and protocol version", async () => {
    const { google, env, tokenUrl } = await signedIn();
    const bridge = session(google.mcpUrl, env, tokenUrl);
    await bridge.ask(initialize);
    bridge.notify(initialized);
    const tools = await bridge.ask(listTools);
    expect(await bridge.end()).toMatchObject({ code: 0 });

    expect(tools.result?.tools).toEqual([expect.objectContaining({ name: 'read_doc' })]);
    const calls = google.mcpCalls;
    expect(calls.every((call) => call.auth?.startsWith('Bearer access-'))).toBe(true);
    expect(new Set(calls.map((call) => call.auth)).size).toBe(1);
    expect(google.tokenCalls.filter((call) => call.grant_type === 'refresh_token')).toHaveLength(1);
    // After initialize every call carries the session Google gave.
    expect(calls.slice(1).map((call) => call.session)).toEqual(['session-1', 'session-1']);
  });

  it('shares one token request between calls that arrive together', async () => {
    const { google, env, tokenUrl } = await signedIn();
    const bridge = session(google.mcpUrl, env, tokenUrl);
    await Promise.all([bridge.ask(initialize), bridge.ask(listTools)]);
    await bridge.end();
    expect(google.tokenCalls.filter((call) => call.grant_type === 'refresh_token')).toHaveLength(1);
  });

  it('reads an event stream answer', async () => {
    const { google, env, tokenUrl } = await signedIn({ sse: true });
    const bridge = session(google.mcpUrl, env, tokenUrl);
    const answer = await bridge.ask(initialize);
    await bridge.end();
    expect(answer.result?.serverInfo).toBeDefined();
  });

  it('mints a new token and tries the call again once when Google stops taking the old one', async () => {
    const { google, env, tokenUrl } = await signedIn();
    const bridge = session(google.mcpUrl, env, tokenUrl);
    await bridge.ask(initialize);
    google.expireAccessTokens();
    const tools = await bridge.ask(listTools);
    await bridge.end();
    expect(tools.result?.tools).toHaveLength(1);
    expect(google.tokenCalls.filter((call) => call.grant_type === 'refresh_token')).toHaveLength(2);
  });

  it('answers a call with an error that names the sign-in, never the token, when Google refuses it for good', async () => {
    const { google, env, tokenUrl } = await signedIn();
    google.revoke(env.GOOGLE_REFRESH_TOKEN);
    const bridge = session(google.mcpUrl, env, tokenUrl);
    const answer = await bridge.ask(initialize);
    const { code, log } = await bridge.end();
    expect(code).toBe(0);
    expect(answer.error?.message).toContain('Connect the Connector again');
    expect(JSON.stringify(bridge.replies) + log).not.toContain(env.GOOGLE_REFRESH_TOKEN);
  });

  it("refuses to start without the console's sign-in", async () => {
    const bridge = session('http://127.0.0.1:1/mcp', {});
    const { code, log } = await bridge.end();
    expect(code).toBe(2);
    expect(log).toContain('Connect the Connector again');
  });
});
