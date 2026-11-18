import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

export const GOOGLE_AUTH = Symbol('GOOGLE_AUTH');

/** The Google OAuth client this build ships (a Desktop app's). */
export type GoogleClient = { clientId: string; clientSecret: string };

export type GoogleEndpoints = { auth: string; token: string; revoke: string };

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
};

/** Why a Google sign-in ended without a token. */
export class GoogleSignInError extends Error {
  constructor(
    readonly kind: 'timeout' | 'declined' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

/** Google's sign-in for the Google Connectors. Tests point it at a stand-in for Google. */
export interface GoogleAuth {
  /** The client the build ships, or `null` when it has none. */
  client(): GoogleClient | null;
  /**
   * Opens Google's account chooser and consent screen through `onUrl`, and ends with the refresh token and the account's
   * email when the operator finishes, or rejects: `GoogleSignInError`, or an abort on `signal`.
   */
  signIn(
    scopes: string[],
    signal: AbortSignal,
    onUrl: (url: string) => void,
  ): Promise<{ refreshToken: string; email: string | null }>;
  /** Whether the refresh token still works: `false` when Google refuses it. Throws when Google does not answer. */
  check(refreshToken: string): Promise<boolean>;
  /** Takes the token's access back at Google. Throws when Google does not answer. */
  revoke(refreshToken: string): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 10_000;
/** A sign-in the operator leaves open this long ends. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

const tokenAnswer = z.object({
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  error: z.string().optional(),
});

const base64url = (data: Buffer) => data.toString('base64url');

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>Ops Console</title><body style="font:16px system-ui;margin:4em auto;max-width:28em"><p>${message}</p>`;

const idClaims = z.object({ email: z.string().optional() });

/** The email Google put in the ID token it handed this process over TLS; nothing to verify. */
function emailOf(idToken: string | undefined): string | null {
  if (idToken === undefined) return null;
  try {
    const claims = idClaims.parse(JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')));
    return claims.email ?? null;
  } catch {
    return null;
  }
}

/** The authorization code flow with PKCE, to a loopback page on this Mac. */
export class LoopbackGoogleAuth implements GoogleAuth {
  constructor(
    private readonly shipped: GoogleClient | null,
    private readonly endpoints: GoogleEndpoints = GOOGLE_ENDPOINTS,
    private readonly timeoutMs: number = SIGN_IN_TIMEOUT_MS,
  ) {}

  client(): GoogleClient | null {
    return this.shipped;
  }

  async signIn(
    scopes: string[],
    signal: AbortSignal,
    onUrl: (url: string) => void,
  ): Promise<{ refreshToken: string; email: string | null }> {
    const client = this.need();
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    let timer: NodeJS.Timeout | undefined;
    let stop = () => {};
    try {
      const code = new Promise<string>((resolve, reject) => {
        server.on('request', (request, response) => {
          const url = new URL(request.url ?? '/', redirect);
          const reply = (status: number, message: string) => {
            response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
            response.end(PAGE(message));
          };
          // The browser also asks for an icon; only Google's redirect carries the state.
          if (url.searchParams.get('state') !== state) return reply(404, 'Not a sign-in for Ops Console.');
          const error = url.searchParams.get('error');
          const given = url.searchParams.get('code');
          if (error !== null || given === null) {
            reply(400, 'Google did not sign you in. You can close this tab.');
            return reject(new GoogleSignInError('declined', `Google did not sign in: ${error ?? 'no code came back'}`));
          }
          reply(200, 'Signed in. You can close this tab and go back to Ops Console.');
          resolve(given);
        });
        timer = setTimeout(
          () => reject(new GoogleSignInError('timeout', 'sign-in did not finish within 5 minutes')),
          this.timeoutMs,
        );
        stop = () => reject(signal.reason ?? new Error('aborted'));
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      });
      const page = new URL(this.endpoints.auth);
      page.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: scopes.join(' '),
        code_challenge: base64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        // The account chooser every time, and a refresh token even when this app was allowed before.
        prompt: 'select_account consent',
      }).toString();
      onUrl(page.toString());
      const given = await code;
      const body = await this.post(this.endpoints.token, {
        grant_type: 'authorization_code',
        code: given,
        redirect_uri: redirect,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code_verifier: verifier,
      });
      const tokens = tokenAnswer.safeParse(await body.json().catch(() => ({})));
      if (!tokens.success || !body.ok || tokens.data.refresh_token === undefined) {
        const reason = tokens.success ? tokens.data.error : undefined;
        throw new GoogleSignInError('failed', `Google did not accept the sign-in${reason ? `: ${reason}` : ''}`);
      }
      return { refreshToken: tokens.data.refresh_token, email: emailOf(tokens.data.id_token) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      server.close();
      server.closeAllConnections();
    }
  }

  async check(refreshToken: string): Promise<boolean> {
    const client = this.need();
    const answer = await this.post(this.endpoints.token, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    if (answer.ok) return true;
    // Revoked, expired, or the password changed: only this answer means signing in again.
    const failure = tokenAnswer.safeParse(await answer.json().catch(() => ({})));
    if (answer.status === 400 && failure.success && failure.data.error === 'invalid_grant') return false;
    throw new Error(`Google answered ${answer.status}`);
  }

  async revoke(refreshToken: string): Promise<void> {
    const answer = await this.post(this.endpoints.revoke, { token: refreshToken });
    if (!answer.ok && answer.status !== 400) throw new Error(`Google answered ${answer.status}`);
  }

  private need(): GoogleClient {
    if (this.shipped === null) throw new GoogleSignInError('failed', 'Google sign-in is not set up in this build');
    return this.shipped;
  }

  private post(url: string, form: Record<string, string>): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}
