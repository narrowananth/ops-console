import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GoogleClient, GoogleEndpoints } from '../../src/connectors/google-auth';

type Grant = { challenge: string; redirect: string };

/**
 * A stand-in for Google on loopback: the account chooser (a redirect), the token and revoke endpoints, and an MCP
 * server that takes a bearer token. It records what it was asked.
 */
export class FakeGoogle {
  readonly client: GoogleClient = { clientId: 'test-client.apps.example.com', clientSecret: 'test-client-secret' };
  /** The account the operator picks in the chooser. */
  email = 'operator@example.com';
  /** The operator declines on the consent screen. */
  deny = false;
  /** Answer MCP calls as an event stream. */
  sse = false;
  readonly scopes: string[][] = [];
  readonly tokenCalls: Record<string, string>[] = [];
  readonly mcpCalls: { auth: string | undefined; session: string | undefined; body: unknown }[] = [];
  readonly revoked = new Set<string>();
  private readonly grants = new Map<string, Grant>();
  private readonly refreshTokens = new Set<string>();
  private accessTokens = new Set<string>();
  private issued = 0;
  private server!: Server;
  private origin = '';

  static async start(): Promise<FakeGoogle> {
    const google = new FakeGoogle();
    google.server = createServer((request, response) => void google.handle(request, response));
    await new Promise<void>((resolve) => google.server.listen(0, '127.0.0.1', resolve));
    google.origin = `http://127.0.0.1:${(google.server.address() as AddressInfo).port}`;
    return google;
  }

  get endpoints(): GoogleEndpoints {
    return { auth: `${this.origin}/auth`, token: `${this.origin}/token`, revoke: `${this.origin}/revoke` };
  }

  get mcpUrl(): string {
    return `${this.origin}/mcp/v1`;
  }

  /** The operator in the browser: opens the sign-in page, which sends the code back to the console's loopback page. */
  async visit(url: string): Promise<void> {
    const redirect = await fetch(url, { redirect: 'manual' });
    const back = redirect.headers.get('location');
    if (back) await fetch(back);
  }

  /** Every access token stops working: the next call gets a 401. */
  expireAccessTokens(): void {
    this.accessTokens = new Set();
  }

  /** Google refuses a refresh token from now on, as after the operator removes the app's access. */
  revoke(token: string): void {
    this.revoked.add(token);
  }

  get refreshToken(): string | undefined {
    return [...this.refreshTokens][0];
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.origin);
    const body = await new Promise<string>((resolve) => {
      let data = '';
      request.on('data', (chunk) => {
        data += chunk;
      });
      request.on('end', () => resolve(data));
    });
    if (url.pathname === '/auth') return this.chooser(url, response);
    if (url.pathname === '/token') return this.token(new URLSearchParams(body), response);
    if (url.pathname === '/revoke') {
      this.revoked.add(new URLSearchParams(body).get('token') ?? '');
      response.writeHead(200).end();
      return;
    }
    if (url.pathname === '/mcp/v1') return this.mcp(request, body, response);
    response.writeHead(404).end();
  }

  private chooser(url: URL, response: ServerResponse): void {
    const redirect = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    this.scopes.push((url.searchParams.get('scope') ?? '').split(' '));
    const back = new URL(redirect);
    back.searchParams.set('state', state);
    if (this.deny) {
      back.searchParams.set('error', 'access_denied');
    } else {
      const code = randomBytes(8).toString('hex');
      this.grants.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirect });
      back.searchParams.set('code', code);
    }
    response.writeHead(302, { location: back.toString() }).end();
  }

  private token(form: URLSearchParams, response: ServerResponse): void {
    this.tokenCalls.push(Object.fromEntries(form));
    const reply = (status: number, json: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    };
    if (form.get('client_id') !== this.client.clientId || form.get('client_secret') !== this.client.clientSecret) {
      reply(401, { error: 'invalid_client' });
      return;
    }
    this.issued += 1;
    const access = `access-${this.issued}`;
    this.accessTokens.add(access);
    if (form.get('grant_type') === 'authorization_code') {
      const grant = this.grants.get(form.get('code') ?? '');
      const proof = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (!grant || grant.challenge !== proof || grant.redirect !== form.get('redirect_uri')) {
        reply(400, { error: 'invalid_grant' });
        return;
      }
      const refresh = `refresh-${randomBytes(6).toString('hex')}`;
      this.refreshTokens.add(refresh);
      const claims = Buffer.from(JSON.stringify({ email: this.email })).toString('base64url');
      reply(200, {
        access_token: access,
        refresh_token: refresh,
        expires_in: 3600,
        id_token: `header.${claims}.signature`,
      });
      return;
    }
    const refresh = form.get('refresh_token') ?? '';
    if (!this.refreshTokens.has(refresh) || this.revoked.has(refresh)) {
      reply(400, { error: 'invalid_grant' });
      return;
    }
    reply(200, { access_token: access, expires_in: 3600 });
  }

  private mcp(request: IncomingMessage, body: string, response: ServerResponse): void {
    const auth = request.headers.authorization;
    const message = JSON.parse(body || 'null') as { id?: number; method?: string; params?: { name?: string } } | null;
    this.mcpCalls.push({ auth, session: request.headers['mcp-session-id'] as string | undefined, body: message });
    if (!auth?.startsWith('Bearer ') || !this.accessTokens.has(auth.slice(7))) {
      response.writeHead(401).end('unauthorized');
      return;
    }
    if (message?.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-google', version: '1' },
          }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'read_doc', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: `read ${message.params?.name ?? ''} as ${this.email}` }] };
    const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
    const headers: Record<string, string> = {
      'content-type': this.sse ? 'text/event-stream' : 'application/json',
      ...(message.method === 'initialize' ? { 'mcp-session-id': 'session-1' } : {}),
    };
    response.writeHead(200, headers).end(this.sse ? `event: message\ndata: ${reply}\n\n` : reply);
  }
}
