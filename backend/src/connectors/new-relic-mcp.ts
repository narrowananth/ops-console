import { NEW_RELIC_MCP_URLS, NEW_RELIC_REGIONS } from '@ops-console/shared';
import { z } from 'zod';
import type { ClaudeCredentials } from './claude-credentials';
import { HostedAuthError, HostedFailed, type HostedOpen, type HostedTools, hostedMcp } from './hosted-mcp';

export type NewRelicRegion = (typeof NEW_RELIC_REGIONS)[number];

/** The MCP server's name in Claude Code's config, which is how its stored sign-in is found. */
export const NEW_RELIC_SERVER = 'newrelic';

export type NewRelicHosts = Partial<Record<NewRelicRegion, string>>;

/**
 * New Relic's hosted server, signed in with the token Claude Code stored for it. The console never refreshes that
 * token: when it has ended, or New Relic refuses it, the one server is reconnected through Claude Code with no model
 * turn (`reconnect`), the token is read again, and the call runs once more. A token that is still no good is a
 * `HostedAuthError`.
 */
export class NewRelicMcp {
  constructor(
    private readonly credentials: ClaudeCredentials,
    private readonly reconnect: () => Promise<void>,
    /** Where to call, by Region; the addresses New Relic documents unless a test points elsewhere. */
    private readonly hosts: NewRelicHosts = {},
  ) {}

  /** The MCP server's two tools as `NewRelicQueries`. */
  queries(region: NewRelicRegion): NewRelicOpen {
    const open = this.open(region);
    return (use, signal) => open(async (tools) => use(await newRelicTools(tools)), signal);
  }

  open(region: NewRelicRegion): HostedOpen {
    const url = this.hosts[region] ?? NEW_RELIC_MCP_URLS[region];
    return async (use, signal) => {
      const live = async (): Promise<string | null> => {
        const token = await this.credentials.mcpToken(NEW_RELIC_SERVER, NEW_RELIC_MCP_URLS[region]);
        if (token === null)
          throw new HostedAuthError(
            'Claude Code holds no New Relic sign-in the console can read, or macOS did not allow the read',
          );
        const ended = token.expiresAt !== null && token.expiresAt <= Date.now();
        return ended ? null : token.accessToken;
      };
      const attempt = async (bearer: string) => hostedMcp(url, { bearer })(use, signal);
      const first = await live();
      if (first !== null) {
        try {
          return await attempt(first);
        } catch (error) {
          if (!(error instanceof HostedAuthError)) throw error;
        }
      }
      await this.reconnect();
      const second = await live();
      if (second === null) throw new HostedAuthError('New Relic needs signing in again');
      return attempt(second);
    };
  }
}

export type NewRelicRow = Record<string, unknown>;
export type NewRelicAccount = { id: string; name: string };

/** What the console asks of New Relic, whichever route reaches it. Each method throws the errors of `hosted-mcp.ts`. */
export interface NewRelicQueries {
  accounts(): Promise<NewRelicAccount[]>;
  /** The rows of one NRQL query for the account. */
  nrql(accountId: string, query: string): Promise<NewRelicRow[]>;
}

/** Opens one session with New Relic on a route, runs `use`, closes it. */
export type NewRelicOpen = <T>(use: (queries: NewRelicQueries) => Promise<T>, signal?: AbortSignal) => Promise<T>;

const rowSchema = z.record(z.string(), z.unknown());
const nrqlAnswer = z.union([
  z.array(rowSchema).transform((results) => ({ results, truncated: false })),
  z.looseObject({ results: z.array(rowSchema), truncated: z.boolean().optional() }).transform((answer) => ({
    results: answer.results,
    truncated: answer.truncated === true,
  })),
]);

const accountItem = z
  .looseObject({
    id: z.union([z.string(), z.number()]).optional(),
    accountId: z.union([z.string(), z.number()]).optional(),
    account_id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
  })
  .transform((item): NewRelicAccount | null => {
    const id = item.id ?? item.accountId ?? item.account_id;
    return id === undefined ? null : { id: String(id), name: item.name ?? String(id) };
  });
const accountsAnswer = z.union([
  z.array(accountItem),
  z.looseObject({ accounts: z.array(accountItem) }).transform((a) => a.accounts),
]);

const NRQL_TOOL = 'execute_nrql_query';
const ACCOUNTS_TOOL = 'list_available_new_relic_accounts';

/** The tool's argument that holds `kind`, named as the server's own schema names it. */
const argumentOf = (properties: string[], kind: RegExp, fallback: string): string =>
  properties.find((name) => kind.test(name)) ?? fallback;

/**
 * The two tools the console calls. The server documents their names and not their arguments, so the argument names
 * are read from the tool list of the session, and a server without a tool says so in its own terms.
 */
export async function newRelicTools(tools: HostedTools): Promise<NewRelicQueries> {
  const offered = await tools.list();
  const need = (name: string) => {
    const found = offered.find((tool) => tool.name === name);
    if (!found) throw new HostedFailed(`New Relic's server has no tool named ${name}`);
    return found;
  };
  return {
    async accounts(): Promise<NewRelicAccount[]> {
      need(ACCOUNTS_TOOL);
      const found = await tools.callJson(ACCOUNTS_TOOL, {}, accountsAnswer);
      return found.flatMap((account) => (account === null ? [] : [account]));
    },
    async nrql(accountId: string, query: string): Promise<NewRelicRow[]> {
      const { properties } = need(NRQL_TOOL);
      const account = argumentOf(properties, /account/i, 'account_id');
      const text = argumentOf(properties, /^(nrql|query)/i, 'query');
      const answer = await tools.callJson(NRQL_TOOL, { [account]: Number(accountId), [text]: query }, nrqlAnswer);
      if (answer.truncated) throw new HostedFailed('the server cut the result at its own row limit');
      return answer.results;
    },
  };
}
