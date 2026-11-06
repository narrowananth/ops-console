import type { TokenCounts } from '@ops-console/shared';

/** USD per million tokens, one row per model family. The only place a price is written down. */
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * Published list prices, per million tokens. A subscription is not billed by the token, so what the console shows is
 * an estimate at these rates. Keyed by the start of the model id; the first match wins.
 */
export const PRICES: { prefix: string; price: Price }[] = [
  { prefix: 'claude-opus', price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { prefix: 'claude-sonnet', price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { prefix: 'claude-haiku', price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { prefix: 'claude-fable', price: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
];

/** A model the table does not know is priced like the dearest family, so an estimate is never too low. */
export const UNKNOWN_PRICE: Price = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };

const PER_MILLION = 1_000_000;

export function priceOf(model: string | null): Price {
  const id = (model ?? '').toLowerCase();
  return PRICES.find((row) => id.startsWith(row.prefix))?.price ?? UNKNOWN_PRICE;
}

/** What `tokens` cost on `model`: each bucket at its own price. */
export function costOf(tokens: TokenCounts, model: string | null): number {
  const price = priceOf(model);
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cache_read * price.cacheRead +
      tokens.cache_write * price.cacheWrite) /
    PER_MILLION
  );
}

export const noTokens = (): TokenCounts => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
  };
}

export const sumTokens = (tokens: TokenCounts) => tokens.input + tokens.output + tokens.cache_read + tokens.cache_write;

/** The tokens of one agent on one model: a line of a run's usage. `agent_id` is null for the main agent. */
export type UsageLine = { agent_id: string | null; model: string } & TokenCounts;

/** Adds lines that name the same agent and model. */
export function mergeLines(lines: UsageLine[]): UsageLine[] {
  const merged = new Map<string, UsageLine>();
  for (const line of lines) {
    const key = `${line.agent_id ?? ''}\u0000${line.model}`;
    const had = merged.get(key);
    merged.set(key, had ? { ...had, ...addTokens(had, line) } : { ...line });
  }
  return [...merged.values()];
}
