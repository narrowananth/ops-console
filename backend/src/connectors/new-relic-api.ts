import { z } from 'zod';
import {
  HostedAuthError,
  HostedFailed,
  HostedRateLimited,
  HostedUnreachable,
  HostedUnreadable,
  RATE_LIMITED,
  reasonOf,
} from './hosted-mcp';
import type {
  NewRelicAccount,
  NewRelicHosts,
  NewRelicOpen,
  NewRelicQueries,
  NewRelicRegion,
  NewRelicRow,
} from './new-relic-mcp';

/** The Keychain item of the New Relic User API key (ADR 0004). */
export const NEW_RELIC_KEY = 'connection:new_relic_logs';

/** NerdGraph's address in each Region, as New Relic documents them. The Region comes from the enum, never from input. */
export const NERDGRAPH_URLS: Record<NewRelicRegion, string> = {
  US: 'https://api.newrelic.com/graphql',
  EU: 'https://api.eu.newrelic.com/graphql',
  JP: 'https://api.jp.newrelic.com/graphql',
};

/** A query that scans logs takes seconds; NerdGraph's own default wait is shorter. */
const NRQL_SECONDS = 60;
/** The call waits a little longer than the query may run. */
const NRQL_CALL_MS = (NRQL_SECONDS + 10) * 1000;
const ACCOUNTS_CALL_MS = 20_000;

const ACCOUNTS = '{ actor { accounts { id name } } }';
const NRQL = `query Run($id: Int!, $nrql: Nrql!) { actor { account(id: $id) { nrql(query: $nrql, timeout: ${NRQL_SECONDS}) { results } } } }`;

const envelope = z.looseObject({
  data: z.unknown().optional(),
  errors: z.array(z.looseObject({ message: z.string() })).optional(),
});
const accountsData = z.object({
  actor: z.object({ accounts: z.array(z.looseObject({ id: z.union([z.number(), z.string()]), name: z.string() })) }),
});
const nrqlData = z.object({
  actor: z.object({
    account: z.object({ nrql: z.object({ results: z.array(z.record(z.string(), z.unknown())) }) }),
  }),
});

/** The text with the key, and anything shaped like a New Relic key, replaced: an error that is shown holds none. */
export function scrubKey(text: string, key: string): string {
  return text.replaceAll(key, '[key]').replace(/NRAK-[A-Za-z0-9_-]+/g, '[key]');
}

/**
 * One call to NerdGraph with the User API key. The key goes in the `API-Key` header and nowhere else, and a redirect
 * is an error, so no other host receives it. A failure is one of the typed errors the MCP route throws.
 */
async function call<S extends z.ZodType>(
  url: string,
  key: string,
  body: { query: string; variables?: Record<string, unknown> },
  schema: S,
  limitMs: number,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(limitMs)]),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    throw new HostedUnreachable(reasonOf(error));
  }
  if (response.status === 401 || response.status === 403) {
    throw new HostedAuthError('New Relic refused the User API key');
  }
  if (response.status === 429) throw new HostedRateLimited('rate limit reached');
  if (!response.ok) throw new HostedFailed(`New Relic's API answered HTTP ${response.status}`);
  const unreadable = () => new HostedUnreadable("New Relic's API gave an answer the console cannot read");
  const parsed = envelope.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw unreadable();
  const { data, errors } = parsed.data;
  if (errors && errors.length > 0) {
    const message = scrubKey(errors.map((error) => error.message).join('; '), key);
    throw RATE_LIMITED.test(message) ? new HostedRateLimited(message) : new HostedFailed(message);
  }
  const answer = schema.safeParse(data);
  if (!answer.success) throw unreadable();
  return answer.data;
}

function queriesFor(url: string, key: string, signal?: AbortSignal): NewRelicQueries {
  return {
    async accounts(): Promise<NewRelicAccount[]> {
      const { actor } = await call(url, key, { query: ACCOUNTS }, accountsData, ACCOUNTS_CALL_MS, signal);
      return actor.accounts.map(({ id, name }) => ({ id: String(id), name }));
    },
    async nrql(accountId: string, query: string): Promise<NewRelicRow[]> {
      const { actor } = await call(
        url,
        key,
        { query: NRQL, variables: { id: Number(accountId), nrql: query } },
        nrqlData,
        NRQL_CALL_MS,
        signal,
      );
      return actor.account.nrql.results;
    },
  };
}

/**
 * New Relic's regular API (NerdGraph), read with the operator's User API key. The key is read from the Keychain for
 * each session and held in memory for it. A key New Relic refuses, or none stored, is a `HostedAuthError`.
 */
export class NewRelicApi {
  constructor(
    private readonly storedKey: () => Promise<string | null>,
    /** Where to call, by Region; the addresses New Relic documents unless a test points elsewhere. */
    private readonly hosts: NewRelicHosts = {},
  ) {}

  private url(region: NewRelicRegion): string {
    return this.hosts[region] ?? NERDGRAPH_URLS[region];
  }

  /** The stored key's reads. */
  open(region: NewRelicRegion): NewRelicOpen {
    return async (use, signal) => {
      const key = await this.storedKey();
      if (key === null) throw new HostedAuthError('no New Relic User API key is stored');
      return use(queriesFor(this.url(region), key, signal));
    };
  }

  /** The accounts a key not yet stored can read, which proves it works. */
  accountsOf(region: NewRelicRegion, key: string): Promise<NewRelicAccount[]> {
    return queriesFor(this.url(region), key).accounts();
  }
}
