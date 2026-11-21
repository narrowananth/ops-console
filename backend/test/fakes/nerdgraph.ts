import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Event, NrqlError, runNrql } from './new-relic-logs';

type Behavior =
  | 'throttle'
  | 'unauthorized'
  | 'forbidden'
  | 'graphqlError'
  | 'leakyError'
  | 'unreadable'
  | 'hang'
  | null;

/** One request the fake received: the `API-Key` header and the GraphQL document with its variables. */
export type NerdGraphCall = {
  key: string | undefined;
  path: string;
  query: string;
  variables: Record<string, unknown>;
};

/**
 * A loopback stand-in for New Relic's NerdGraph API, shaped from New Relic's documentation: `POST /graphql` with an
 * `API-Key` header, `actor.accounts` for the list and `actor.account(id) { nrql(query:) { results } }` for a query. It
 * takes only the keys a test grants and runs NRQL over log events a test wrote, with the same engine as the MCP
 * stand-in.
 */
export class FakeNerdGraph {
  private readonly keys = new Set<string>();
  private readonly stored: Event[] = [];
  private known = [{ id: 1234567, name: 'Example Prod' }];
  private behavior: Behavior = null;
  private only: number | null = null;
  private readonly log: NerdGraphCall[] = [];
  private server!: Server;
  url = '';

  static async start(): Promise<FakeNerdGraph> {
    const fake = new FakeNerdGraph();
    fake.server = createServer((request, response) => void fake.handle(request, response));
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/graphql`;
    return fake;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** The API takes this key from now on. */
  grant(key: string): this {
    this.keys.add(key);
    return this;
  }

  /** Every key is refused until `grant` gives one again, as after a revoke. */
  revokeKeys(): this {
    this.keys.clear();
    return this;
  }

  accounts(accounts: { id: number; name: string }[]): this {
    this.known = accounts;
    return this;
  }

  events(...events: Event[]): this {
    this.stored.push(
      ...events.map(({ at, attrs }) => ({ at, attrs: JSON.parse(JSON.stringify(attrs)) as typeof attrs })),
    );
    return this;
  }

  /** Every call answers as a throttled API (429), a refusing one (401, 403), a failing one or a slow one does. */
  behave(behavior: Behavior): this {
    this.behavior = behavior;
    return this;
  }

  /** A query for any other account answers a GraphQL error. */
  requiresAccount(id: number): this {
    this.only = id;
    return this;
  }

  calls(): NerdGraphCall[] {
    return this.log;
  }

  /** The NRQL of each query received, in order. */
  queries(): string[] {
    return this.log.flatMap((call) => (typeof call.variables.nrql === 'string' ? [call.variables.nrql] : []));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const key = request.headers['api-key'];
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    this.log.push({
      key: typeof key === 'string' ? key : undefined,
      path: request.url ?? '',
      query: body.query ?? '',
      variables: body.variables ?? {},
    });
    if (request.method !== 'POST' || request.url !== '/graphql') return send(404, {});
    if (this.behavior === 'hang') return;
    if (this.behavior === 'throttle') return send(429, { error: 'Too many requests' });
    if (this.behavior === 'unauthorized') return send(401, { error: 'Invalid API key' });
    if (this.behavior === 'forbidden') return send(403, { error: 'Forbidden' });
    if (typeof key !== 'string' || !this.keys.has(key)) return send(401, { error: 'Invalid API key' });
    if (this.behavior === 'unreadable') return send(200, 'this is not what the API answers');
    if (this.behavior === 'graphqlError') return send(200, { errors: [{ message: 'Something went wrong' }] });
    // An API that echoes the credential it was given, which the console must not repeat.
    if (this.behavior === 'leakyError') return send(200, { errors: [{ message: `Bad request from ${key}` }] });
    if (/\bnrql\b/.test(body.query ?? '')) {
      const account = Number(body.variables?.id);
      if (this.only !== null && account !== this.only) {
        return send(200, { data: { actor: { account: null } }, errors: [{ message: `account ${account} not found` }] });
      }
      try {
        const results = runNrql(this.stored, String(body.variables?.nrql ?? ''), 'array');
        return send(200, { data: { actor: { account: { nrql: { results } } } } });
      } catch (error) {
        if (error instanceof NrqlError)
          return send(200, { data: { actor: { account: null } }, errors: [{ message: error.message }] });
        throw error;
      }
    }
    return send(200, { data: { actor: { accounts: this.known } } });
  }
}
