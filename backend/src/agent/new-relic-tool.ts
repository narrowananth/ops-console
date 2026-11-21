import { z } from 'zod';
import { redact } from '../action-log/redact';
import { ApiError } from '../common/errors';
import { CONSOLE_TOOLS_SERVER } from './session-tools';

export const NEW_RELIC_QUERY_TOOL = `mcp__${CONSOLE_TOOLS_SERVER}__query_new_relic`;

export const newRelicQueryInputSchema = z.object({
  /** NRQL text: a `SELECT` or `FROM` query, or `SHOW EVENT TYPES`. The account and Region are the Connector's own. */
  nrql: z.string().trim().min(1).max(4_000),
});
export type NewRelicQueryInput = z.infer<typeof newRelicQueryInputSchema>;

/** What the agent's `query_new_relic` tool calls. The Monitor module provides it. */
export interface NewRelicQuery {
  /** Whether New Relic logs are connected through a User API key: the daemon alone holds that key. */
  offers(): boolean;
  /** The rows of the query for the Connector's account. Throws an `ApiError` with a message safe to show. */
  rows(nrql: string): Promise<Record<string, unknown>[]>;
}

/** The most rows one call hands to the agent; NRQL's own `LIMIT` ceiling is 5,000. */
export const AGENT_ROWS = 200;

/** Why this NRQL is not run, or null when it is a read. NRQL has no write verb: this keeps the tool to queries. */
export function nrqlRefusal(nrql: string): string | null {
  return /^\s*(SELECT|FROM|SHOW)\b/i.test(nrql) ? null : 'Only a SELECT, FROM or SHOW query runs here.';
}

/** The tool's answer to the agent: the rows, cut at `AGENT_ROWS`, or why nothing ran. */
export async function runNewRelicQuery(
  query: NewRelicQuery,
  input: NewRelicQueryInput,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const refusal = nrqlRefusal(input.nrql);
  if (refusal !== null) return { content: [{ type: 'text', text: refusal }], isError: true };
  try {
    const rows = await query.rows(input.nrql);
    const shown = rows.slice(0, AGENT_ROWS);
    const cut =
      rows.length > shown.length ? `\n(${rows.length - shown.length} more rows were cut; narrow the query.)` : '';
    return { content: [{ type: 'text', text: `${redact(JSON.stringify(shown, null, 1))}${cut}` }] };
  } catch (error) {
    const why = error instanceof ApiError ? error.message : 'the query did not run';
    return { content: [{ type: 'text', text: `The query did not run: ${why}` }], isError: true };
  }
}
