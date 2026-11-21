import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { ConnectorId, ErrorCode } from '@ops-console/shared';
import { z } from 'zod';
import { ApiError } from '../common/errors';
import type { Keychain } from '../keychain/keychain';
import { HostedAuthError } from './hosted-mcp';

export const GRAFANA_AUTH = Symbol('GRAFANA_AUTH');

/** The console's own Grafana sign-in: the registered client and its tokens, one Keychain item (ADR 0004). */
export const LOKI_OAUTH_KEY = `connection:${ConnectorId.LokiLogs}_oauth`;

/** Read access only: the console and the agent never write to Grafana. */
const SCOPE = 'grafana:read grafana:query';

/** A sign-in the operator leaves open this long ends. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

const itemSchema = z.object({
  client: OAuthClientInformationFullSchema.optional(),
  tokens: OAuthTokensSchema.optional(),
});
type Item = z.infer<typeof itemSchema>;

/** The daemon's Grafana sign-in. Tests point it at a stand-in for Grafana. */
export interface GrafanaAuth {
  /** Whether the Keychain holds a sign-in. */
  signedIn(): Promise<boolean>;
  /** The client the MCP SDK reads with and refreshes the token through: it never opens a browser. */
  provider(): OAuthClientProvider;
  /**
   * Registers a client, opens Grafana's sign-in through `onUrl`, and ends with the tokens in the Keychain when the
   * operator finishes, or rejects: `invalid_state` when it fails or times out, an abort on `signal`.
   */
  signIn(signal: AbortSignal, onUrl: (url: string) => void): Promise<void>;
}

/** The sign-in item in the Keychain, read and written at the moment of use. */
class Store {
  constructor(private readonly keychain: Keychain) {}

  async read(): Promise<Item> {
    const raw = await this.keychain.get(LOKI_OAUTH_KEY);
    if (raw === null) return {};
    try {
      return itemSchema.parse(JSON.parse(raw));
    } catch {
      return {};
    }
  }

  async write(change: Partial<Item>): Promise<void> {
    await this.keychain.set(LOKI_OAUTH_KEY, JSON.stringify({ ...(await this.read()), ...change }));
  }
}

type Interactive = { redirect: string; state: string; onUrl: (url: string) => void };

/**
 * The MCP SDK's view of the sign-in. A read provider has no redirect and fails with `HostedAuthError` where the SDK
 * would send the operator to a browser; a sign-in provider starts empty and hands the page to `onUrl`.
 */
class Provider implements OAuthClientProvider {
  private verifier = '';
  private client: OAuthClientInformationMixed | undefined;
  private tokensNow: OAuthTokens | undefined;

  constructor(
    private readonly store: Store,
    private readonly interactive: Interactive | null,
  ) {}

  get redirectUrl(): string {
    return this.interactive?.redirect ?? 'http://127.0.0.1/callback';
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Ops Console',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    };
  }

  state(): string {
    return this.interactive?.state ?? '';
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.interactive ? this.client : (await this.store.read()).client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    // Held until the tokens arrive: a sign-in that never finishes leaves nothing in the Keychain.
    this.client = client;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.interactive ? this.tokensNow : (await this.store.read()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.tokensNow = tokens;
    const client = this.client ? OAuthClientInformationFullSchema.safeParse(this.client) : null;
    await this.store.write({ tokens, ...(client?.success ? { client: client.data } : {}) });
  }

  redirectToAuthorization(url: URL): void {
    if (!this.interactive) throw new HostedAuthError('Grafana needs signing in again');
    this.interactive.onUrl(url.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }
}

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Ops Console</title><body style="font:16px system-ui;margin:4em auto;max-width:28em"><p>${message}</p>`;

const base64url = (data: Buffer) => data.toString('base64url');

/** Grafana's sign-in with the MCP SDK's OAuth client, to a loopback page on this Mac that lives for one callback. */
export class LoopbackGrafanaAuth implements GrafanaAuth {
  private readonly store: Store;

  constructor(
    keychain: Keychain,
    private readonly serverUrl: string,
    private readonly timeoutMs: number = SIGN_IN_TIMEOUT_MS,
  ) {
    this.store = new Store(keychain);
  }

  async signedIn(): Promise<boolean> {
    return (await this.store.read()).tokens !== undefined;
  }

  provider(): OAuthClientProvider {
    return new Provider(this.store, null);
  }

  async signIn(signal: AbortSignal, onUrl: (url: string) => void): Promise<void> {
    const state = base64url(randomBytes(16));
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    let timer: NodeJS.Timeout | undefined;
    let stop = () => {};
    try {
      let done = false;
      const code = new Promise<string>((resolve, reject) => {
        server.on('request', (request, response) => {
          const url = new URL(request.url ?? '/', redirect);
          const reply = (status: number, message: string) => {
            response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
            response.end(PAGE(message));
          };
          // The browser also asks for an icon; only Grafana's redirect carries the state.
          if (done || url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
            return reply(404, 'Not a sign-in for Ops Console.');
          }
          done = true;
          const given = url.searchParams.get('code');
          if (url.searchParams.get('error') !== null || given === null) {
            reply(400, 'Grafana did not sign you in. You can close this tab.');
            return reject(new ApiError(409, ErrorCode.InvalidState, 'Grafana did not sign you in'));
          }
          reply(200, 'Signed in. You can close this tab and go back to Ops Console.');
          resolve(given);
        });
        timer = setTimeout(
          () => reject(new ApiError(409, ErrorCode.InvalidState, 'Grafana sign-in did not finish within 5 minutes')),
          this.timeoutMs,
        );
        stop = () => reject(signal.reason ?? new Error('aborted'));
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      });
      // A timeout or a decline while `auth` still runs is picked up by the await below, not left unhandled.
      code.catch(() => {});
      const provider = new Provider(this.store, { redirect, state, onUrl });
      const started = await auth(provider, { serverUrl: this.serverUrl, scope: SCOPE });
      if (started !== 'REDIRECT') throw new ApiError(409, ErrorCode.InvalidState, 'Grafana did not ask for a sign-in');
      const finished = await auth(provider, {
        serverUrl: this.serverUrl,
        authorizationCode: await code,
        scope: SCOPE,
      });
      if (finished !== 'AUTHORIZED')
        throw new ApiError(409, ErrorCode.InvalidState, 'Grafana did not accept the sign-in');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      server.close();
      server.closeAllConnections();
    }
  }
}
