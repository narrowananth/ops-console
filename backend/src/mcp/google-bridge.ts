import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { GOOGLE_HOSTS, type GoogleHosts, type GoogleProduct, googleTools } from './google-tools';

/** What the bridge needs from its environment: the console's Keychain puts these in through `mcp-exec`. */
export const GOOGLE_ENV = {
  clientId: 'GOOGLE_CLIENT_ID',
  clientSecret: 'GOOGLE_CLIENT_SECRET',
  refreshToken: 'GOOGLE_REFRESH_TOKEN',
} as const;

export type GoogleEndpoints = { token: string; hosts: GoogleHosts };

const DEFAULT_ENDPOINTS: GoogleEndpoints = { token: 'https://oauth2.googleapis.com/token', hosts: GOOGLE_HOSTS };
const PRODUCTS: GoogleProduct[] = ['docs', 'sheets', 'drive'];
const EARLY_MS = 60_000;
const CALL_TIMEOUT_MS = 30_000;
const PROTOCOL = '2025-06-18';

const tokenAnswer = z.object({ access_token: z.string().optional(), expires_in: z.number().optional() });
const request = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z
    .object({ protocolVersion: z.string().optional(), name: z.string().optional(), arguments: z.unknown().optional() })
    .optional(),
});

/**
 * `ops-console google-mcp <docs|sheets|drive>`: a stdio MCP server whose tools call that product's Google REST API with
 * an access token it mints from the console's refresh token. Nothing is kept on disk, and stdout carries only the
 * protocol. Ends when stdin does; resolves with the exit code.
 */
export async function runGoogleBridge(
  product: string | undefined,
  env: Record<string, string | undefined>,
  input: Readable,
  output: Writable,
  log: Writable = process.stderr,
  endpoints: GoogleEndpoints = DEFAULT_ENDPOINTS,
): Promise<number> {
  const clientId = env[GOOGLE_ENV.clientId];
  const clientSecret = env[GOOGLE_ENV.clientSecret];
  const refreshToken = env[GOOGLE_ENV.refreshToken];
  if (!clientId || !clientSecret || !refreshToken) {
    log.write("google-mcp: needs the console's Google sign-in; Connect the Connector again\n");
    return 2;
  }
  const chosen = PRODUCTS.find((name) => name === product);
  if (chosen === undefined) {
    log.write(`google-mcp: the product is one of ${PRODUCTS.join(', ')}\n`);
    return 2;
  }
  const tools = googleTools(chosen);
  let access: { token: string; until: number } | null = null;

  const refreshForm = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const send = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
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
    const answer = await fetch(endpoints.token, {
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
    access = { token: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000 - EARLY_MS };
    return body.access_token;
  }

  /** One call to Google. A `401` means the token is no longer taken: one new token, and the call goes again. */
  async function api(url: string, init: { method?: string; body?: unknown; text?: boolean } = {}): Promise<unknown> {
    const call = async () =>
      fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    let response = await call();
    if (response.status === 401) {
      access = null;
      response = await call();
    }
    if (!response.ok) {
      const reason = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`Google answered ${response.status}${reason ? `: ${reason}` : ''}`);
    }
    return init.text ? response.text() : response.json();
  }

  async function handle(line: string): Promise<void> {
    let parsed: z.infer<typeof request>;
    try {
      parsed = request.parse(JSON.parse(line));
    } catch {
      return;
    }
    const { id, method, params } = parsed;
    // A message with no id is a notification: nothing answers it.
    if (id === undefined) return;
    const reply = (result: unknown) => send({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

    if (method === 'initialize') {
      return reply({
        protocolVersion: params?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: `google-${chosen}`, version: '1' },
      });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') {
      return reply({
        tools: tools.map(({ name, description, inputSchema, readOnly }) => ({
          name,
          description,
          inputSchema,
          annotations: { readOnlyHint: readOnly },
        })),
      });
    }
    if (method !== 'tools/call') return fail(-32601, `Method not found: ${method}`);

    const tool = tools.find((candidate) => candidate.name === params?.name);
    if (!tool) return fail(-32602, `Unknown tool: ${params?.name ?? ''}`);
    try {
      const text = await tool.run(params?.arguments, { api, hosts: endpoints.hosts });
      reply({ content: [{ type: 'text', text }] });
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Google did not answer';
      log.write(`google-mcp: ${tool.name}: ${text}\n`);
      reply({ content: [{ type: 'text', text }], isError: true });
    }
  }

  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input })) {
    if (line.trim() === '') continue;
    const call = handle(line).finally(() => pending.delete(call));
    pending.add(call);
  }
  await Promise.all(pending);
  return 0;
}
