import type { AgentUsage, RunUsage, TokenCounts } from '@ops-console/shared';
import { addTokens, costOf, noTokens, sumTokens, type UsageLine } from './pricing';
import type { UsageRow } from './run-steps';

const tokensOf = (line: TokenCounts): TokenCounts => ({
  input: line.input,
  output: line.output,
  cache_read: line.cache_read,
  cache_write: line.cache_write,
});

/**
 * What a run used, from the raw token counts of its lines, each priced on its own model. `total` is main plus every
 * subagent, added once, so the three never disagree. Null when the run was kept without raw counts.
 */
export function runUsageOf(row: UsageRow): RunUsage | null {
  if (row.lines === null) return null;
  return usageOfLines(row.lines, row.costUsd);
}

export function usageOfLines(lines: UsageLine[], reportedCostUsd: number | null): RunUsage {
  const agents = new Map<string | null, AgentUsage>();
  for (const line of lines) {
    const had = agents.get(line.agent_id) ?? { agent_id: line.agent_id, tokens: noTokens(), cost_usd: 0 };
    agents.set(line.agent_id, {
      agent_id: line.agent_id,
      tokens: addTokens(had.tokens, tokensOf(line)),
      cost_usd: had.cost_usd + costOf(line, line.model),
    });
  }
  const sum = (picks: AgentUsage[]) => ({
    tokens: picks.reduce((total, one) => addTokens(total, one.tokens), noTokens()),
    cost_usd: picks.reduce((total, one) => total + one.cost_usd, 0),
  });
  const by_agent = [...agents.values()];
  const main = sum(by_agent.filter((one) => one.agent_id === null));
  const subagents = sum(by_agent.filter((one) => one.agent_id !== null));
  return {
    total: { tokens: addTokens(main.tokens, subagents.tokens), cost_usd: main.cost_usd + subagents.cost_usd },
    main,
    subagents,
    by_agent,
    reported_cost_usd: reportedCostUsd,
    models: [...new Set(lines.map((line) => line.model))],
  };
}

/** The cost and every token of a run, as the lists print them: from the raw counts when kept, else as the SDK said. */
export function costAndTokens(row: UsageRow): { cost_usd: number; tokens: number } {
  const usage = runUsageOf(row);
  return usage
    ? { cost_usd: usage.total.cost_usd, tokens: sumTokens(usage.total.tokens) }
    : { cost_usd: row.costUsd, tokens: row.tokens };
}

/** What runs add up to: the page header's day total, through the same pricing as each run. */
export function totalOf(rows: UsageRow[]): { cost_usd: number; tokens: number; runs: number } {
  let cost = 0;
  let tokens = 0;
  for (const row of rows) {
    const one = costAndTokens(row);
    cost += one.cost_usd;
    tokens += one.tokens;
  }
  return { cost_usd: cost, tokens, runs: rows.length };
}
