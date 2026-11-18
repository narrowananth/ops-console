import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';

/** What the bridge needs from its environment: the console's Keychain puts these in through `mcp-exec`. */
export const GOOGLE_ENV = {
  clientId: 'GOOGLE_CLIENT_ID',
  clientSecret: 'GOOGLE_CLIENT_SECRET',
  refreshToken: 'GOOGLE_REFRESH_TOKEN',
} as const;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const EARLY_MS = 60_000;

const tokenAnswer = z.object({ access_token: z.string().optional(), expires_in: z.number().optional() });

type Message = { id?: string | number | null; method?: string; result?: unknown };

/**
 * `ops-console google-mcp <url>`: a stdio MCP server that relays every message to Google's own MCP server at `url`
 * with an access token it mints from the console's refresh token. Nothing is kept on disk, and stdout carries only the
 * protocol. Ends when stdin does; resolves with the exit code.
 */
export async function runGoogleBridge(
  url: string | undefined,
  env: Record<string, string | undefined>,
  input: Readable,
  output: Writable,
  log: Writable = process.stderr,
  tokenUrl: string = TOKEN_URL,
): Promise<number> {
  const clientId = env[GOOGLE_ENV.clientId];
  const clientSecret = env[GOOGLE_ENV.clientSecret];
  const refreshToken = env[GOOGLE_ENV.refreshToken];
  if (!url || !clientId || !clientSecret || !refreshToken) {
    log.write("google-mcp: needs a server URL and the console's Google sign-in; Connect the Connector again\n");
    return 2;
  }
  let access: { token: string; until: number } | null = null;
  let session: string | null = null;
  let protocol: string | null = null;

  const target: string = url;
  const refreshForm = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);
  const fail = (request: Message, text: string) => {
    if (request.id !== undefined && request.id !== null) {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: text } });
    }
    log.write(`google-mcp: ${text}\n`);
  };

  // Calls that arrive together share one request for the token.
  let minting: Promise<string> | null = null;
  function accessToken(): Promise<string> {
    if (access && access.until > Date.now()) return Promise.resolve(access.token);
    minting ??= mint().finally(() => {
      minting = null;
    });
    return minting;
  }

  async function mint(): Promise<string> {
    const answer = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: refreshForm,
      signal: AbortSignal.timeout(15_000),
    });
    const body = tokenAnswer.parse(await answer.json().catch(() => ({})));
    if (!answer.ok || body.access_token === undefined) {
      throw new Error(
        answer.status === 400
          ? "Google refused the console's sign-in: Connect the Connector again in Ops Console"
          : `Google's token service answered ${answer.status}`,
      );
    }
    const seconds = body.expires_in ?? 3600;
    access = { token: body.access_token, until: Date.now() + seconds * 1000 - EARLY_MS };
    return body.access_token;
  }

  function relay(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const message = item as Message;
      if (message.result && typeof message.result === 'object' && 'protocolVersion' in message.result) {
        protocol = String((message.result as { protocolVersion: unknown }).protocolVersion);
      }
      send(item);
    }
  }

  async function forward(line: string, retry = true): Promise<void> {
    let request: Message;
    try {
      request = JSON.parse(line) as Message;
    } catch {
      return;
    }
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(session ? { 'mcp-session-id': session } : {}),
          ...(protocol ? { 'mcp-protocol-version': protocol } : {}),
        },
        body: line,
      });
      // A token Google no longer takes: one new token, and the call goes again.
      if (response.status === 401 && retry) {
        access = null;
        return await forward(line, false);
      }
      session = response.headers.get('mcp-session-id') ?? session;
      if (!response.ok) {
        const reason = (await response.text().catch(() => '')).slice(0, 300);
        return fail(request, `Google answered ${response.status}${reason ? `: ${reason}` : ''}`);
      }
      if (response.status === 202) return;
      const text = await response.text();
      if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        for (const event of text.split(/\r?\n\r?\n/)) {
          const data = event
            .split(/\r?\n/)
            .filter((row) => row.startsWith('data:'))
            .map((row) => row.slice(5).trimStart())
            .join('\n');
          if (data !== '') relay(data);
        }
      } else if (text !== '') {
        relay(text);
      }
    } catch (error) {
      fail(request, error instanceof Error ? error.message : 'Google did not answer');
    }
  }

  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input })) {
    if (line.trim() === '') continue;
    const call = forward(line).finally(() => pending.delete(call));
    pending.add(call);
  }
  await Promise.all(pending);
  return 0;
}
