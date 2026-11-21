import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { z } from 'zod';

/** One MCP tool call the fake received. `token` is the bearer that made it. */
export type ToolCall = { tool: string; args: Record<string, unknown>; token: string | undefined };

export type ToolResult = { isError?: true; content: { type: 'text'; text: string }[] };

export const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
export const json = (value: unknown): ToolResult => text(JSON.stringify(value));
export const failure = (message: string): ToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

export type ToolDef = {
  name: string;
  inputSchema: z.ZodRawShape;
  run: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
};

/** Waits as a call does that the server never answers. */
export const hang = (): Promise<never> => new Promise<never>(() => {});

type Grant = { challenge: string; redirect: string; clientId: string };

/**
 * A loopback stand-in for a hosted MCP server: a Streamable HTTP endpoint at `/mcp` that takes only the bearer tokens it
 * accepts, and, when `oauth` is on, the discovery, registration, authorization and token endpoints that issue them.
 * Subclasses give the tools. Every tool call is kept in `callLog`.
 */
export abstract class FakeMcpHost {
  readonly callLog: ToolCall[] = [];
  /** The bearer tokens the endpoint accepts now. */
  readonly accepted = new Set<string>();
  /** The clients that registered, by `client_id`. */
  readonly clients = new Map<string, { redirectUris: string[] }>();
  /** The operator declines on the consent screen. */
  deny = false;
  /** Every MCP request is refused with 401, or its connection is cut. */
  protected refuse: 'unauthorized' | 'unreachable' | null = null;
  /** Every tool but a spare one is unknown. */
  protected unknownTools = false;
  private readonly grants = new Map<string, Grant>();
  private readonly refreshTokens = new Set<string>();
  private issued = 0;
  private server!: Server;
  private origin = '';

  protected constructor(private readonly oauth: boolean) {}

  protected abstract tools(): ToolDef[];

  protected async listen(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** The MCP endpoint. */
  get url(): string {
    return `${this.origin}/mcp`;
  }

  /** The operator in the browser: opens the authorization page, which sends the code back to the redirect address. */
  async visit(authorizeUrl: string): Promise<number> {
    const redirect = await fetch(authorizeUrl, { redirect: 'manual' });
    const back = redirect.headers.get('location');
    if (!back) return redirect.status;
    return (await fetch(back)).status;
  }

  /** Tokens as a finished sign-in leaves them: the access token is accepted now, and the refresh token works. */
  issueTokens(): { access_token: string; token_type: 'Bearer'; refresh_token: string; expires_in: number } {
    const access = `access-${++this.issued}`;
    const refresh = `refresh-${randomBytes(6).toString('hex')}`;
    this.accepted.add(access);
    this.refreshTokens.add(refresh);
    return { access_token: access, token_type: 'Bearer', refresh_token: refresh, expires_in: 3600 };
  }

  /** Every access token stops working: the next call gets a 401. */
  expireAccessTokens(): void {
    this.accepted.clear();
  }

  /** The server refuses every refresh token from now on, as after the operator removes the app's access. */
  revokeRefreshTokens(): void {
    this.refreshTokens.clear();
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
    if (url.pathname === '/mcp') return this.mcp(request, response, body);
    if (this.oauth) {
      if (
        url.pathname === '/.well-known/oauth-protected-resource' ||
        url.pathname === '/.well-known/oauth-protected-resource/mcp'
      ) {
        reply(response, 200, { resource: `${this.origin}/mcp`, authorization_servers: [this.origin] });
        return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        reply(response, 200, {
          issuer: this.origin,
          authorization_endpoint: `${this.origin}/oauth/authorize`,
          token_endpoint: `${this.origin}/oauth/token`,
          registration_endpoint: `${this.origin}/oauth/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
        return;
      }
      if (url.pathname === '/oauth/register') return this.register(body, response);
      if (url.pathname === '/oauth/authorize') return this.authorize(url, response);
      if (url.pathname === '/oauth/token') return this.token(new URLSearchParams(body), response);
    }
    response.writeHead(404).end();
  }

  private async mcp(request: IncomingMessage, response: ServerResponse, body: string): Promise<void> {
    if (this.refuse === 'unreachable') {
      request.socket.destroy();
      return;
    }
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (this.refuse === 'unauthorized' || token === undefined || !this.accepted.has(token)) {
      response.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource"`,
      });
      response.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    const server = new McpServer({ name: 'fake-hosted', version: '1.0.0' });
    this.registerTools(server, token);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, body === '' ? undefined : JSON.parse(body));
  }

  private registerTools(server: McpServer, token: string): void {
    if (this.unknownTools) {
      server.registerTool('ping', {}, () => text('pong'));
      return;
    }
    for (const tool of this.tools()) {
      server.registerTool(tool.name, { inputSchema: tool.inputSchema }, async (args: Record<string, unknown>) => {
        this.callLog.push({ tool: tool.name, args, token });
        return tool.run(args);
      });
    }
  }

  private register(body: string, response: ServerResponse): void {
    const asked = JSON.parse(body) as { redirect_uris?: string[]; client_name?: string };
    const clientId = `client-${randomBytes(6).toString('hex')}`;
    this.clients.set(clientId, { redirectUris: asked.redirect_uris ?? [] });
    reply(response, 201, {
      client_id: clientId,
      client_name: asked.client_name,
      redirect_uris: asked.redirect_uris ?? [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  }

  private authorize(url: URL, response: ServerResponse): void {
    const clientId = url.searchParams.get('client_id') ?? '';
    const redirect = url.searchParams.get('redirect_uri') ?? '';
    if (!this.clients.get(clientId)?.redirectUris.includes(redirect)) {
      response.writeHead(400).end('unregistered client or redirect address');
      return;
    }
    const back = new URL(redirect);
    const state = url.searchParams.get('state');
    if (state !== null) back.searchParams.set('state', state);
    if (this.deny) {
      back.searchParams.set('error', 'access_denied');
    } else {
      const code = randomBytes(8).toString('hex');
      this.grants.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirect, clientId });
      back.searchParams.set('code', code);
    }
    response.writeHead(302, { location: back.toString() }).end();
  }

  private token(form: URLSearchParams, response: ServerResponse): void {
    const access = `access-${++this.issued}`;
    if (form.get('grant_type') === 'authorization_code') {
      const grant = this.grants.get(form.get('code') ?? '');
      const proof = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (
        !grant ||
        grant.challenge !== proof ||
        grant.redirect !== form.get('redirect_uri') ||
        grant.clientId !== form.get('client_id')
      ) {
        reply(response, 400, { error: 'invalid_grant' });
        return;
      }
      this.grants.delete(form.get('code') ?? '');
      const refresh = `refresh-${randomBytes(6).toString('hex')}`;
      this.refreshTokens.add(refresh);
      this.accepted.add(access);
      reply(response, 200, {
        access_token: access,
        token_type: 'Bearer',
        refresh_token: refresh,
        expires_in: 3600,
      });
      return;
    }
    const refresh = form.get('refresh_token') ?? '';
    if (form.get('grant_type') !== 'refresh_token' || !this.refreshTokens.has(refresh)) {
      reply(response, 400, { error: 'invalid_grant' });
      return;
    }
    this.accepted.add(access);
    reply(response, 200, { access_token: access, token_type: 'Bearer', refresh_token: refresh, expires_in: 3600 });
  }
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
