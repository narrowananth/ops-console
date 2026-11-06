import { RunPhase } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { costOf, mergeLines, priceOf, sumTokens, type UsageLine } from '../src/agent/pricing';
import { totalOf, usageOfLines } from '../src/agent/run-usage';
import { type AgentDaemon, api, startAgentDaemon, until } from './agent-fixtures';

const M = 1_000_000;

describe('price table', () => {
  it('prices each bucket on its own, per million tokens', () => {
    // Sonnet: input 3, output 15, cache read 0.30, cache write 3.75 dollars per million.
    expect(costOf({ input: M, output: 0, cache_read: 0, cache_write: 0 }, 'claude-sonnet-5-5')).toBeCloseTo(3, 10);
    expect(costOf({ input: 0, output: M, cache_read: 0, cache_write: 0 }, 'claude-sonnet-5-5')).toBeCloseTo(15, 10);
    expect(costOf({ input: 0, output: 0, cache_read: M, cache_write: 0 }, 'claude-sonnet-5-5')).toBeCloseTo(0.3, 10);
    expect(costOf({ input: 0, output: 0, cache_read: 0, cache_write: M }, 'claude-sonnet-5-5')).toBeCloseTo(3.75, 10);
  });

  it('is per million, not per token: 16,126 fresh tokens cost cents, not dollars', () => {
    const cost = costOf({ input: 10_000, output: 6_126, cache_read: 0, cache_write: 0 }, 'claude-sonnet-5-5');
    expect(cost).toBeCloseTo((10_000 * 3 + 6_126 * 15) / M, 10);
    expect(cost).toBeLessThan(0.2);
  });

  it('matches a model by the start of its id, and prices an unknown one like the dearest family', () => {
    expect(priceOf('claude-opus-5-5')).toEqual(priceOf('claude-opus-4-1-20250805'));
    expect(priceOf('claude-haiku-5-5').input).toBeLessThan(priceOf('claude-sonnet-5-5').input);
    expect(priceOf('some-other-model')).toEqual(priceOf(null));
    expect(priceOf('some-other-model').output).toBeGreaterThanOrEqual(priceOf('claude-opus-5-5').output);
  });
});

describe('a run usage from raw lines', () => {
  const lines: UsageLine[] = [
    { agent_id: null, model: 'claude-sonnet-5-5', input: 1000, output: 2000, cache_read: 100_000, cache_write: 10_000 },
    { agent_id: 'a', model: 'claude-sonnet-5-5', input: 500, output: 1000, cache_read: 50_000, cache_write: 5_000 },
    { agent_id: 'b', model: 'claude-haiku-5-5', input: 200, output: 300, cache_read: 0, cache_write: 0 },
  ];

  it('gives the exact expected cost per bucket, and total equals main plus the subagents', () => {
    const usage = usageOfLines(lines, 58.7);
    const main = (1000 * 3 + 2000 * 15 + 100_000 * 0.3 + 10_000 * 3.75) / M;
    const a = (500 * 3 + 1000 * 15 + 50_000 * 0.3 + 5_000 * 3.75) / M;
    const b = (200 * 1 + 300 * 5) / M;
    expect(usage.main.cost_usd).toBeCloseTo(main, 10);
    expect(usage.subagents.cost_usd).toBeCloseTo(a + b, 10);
    expect(usage.total.cost_usd).toBe(usage.main.cost_usd + usage.subagents.cost_usd);
    expect(usage.total.tokens).toEqual({ input: 1700, output: 3300, cache_read: 150_000, cache_write: 15_000 });
    expect(usage.by_agent.map((one) => [one.agent_id, one.tokens.input])).toEqual([
      [null, 1000],
      ['a', 500],
      ['b', 200],
    ]);
    expect(usage.by_agent.reduce((sum, one) => sum + one.cost_usd, 0)).toBeCloseTo(usage.total.cost_usd, 10);
    expect(usage.reported_cost_usd).toBe(58.7);
    expect(usage.models).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
  });

  it('adds lines of one agent and model together, and keeps others apart', () => {
    const merged = mergeLines([
      ...lines,
      { agent_id: null, model: 'claude-sonnet-5-5', input: 1, output: 0, cache_read: 0, cache_write: 0 },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[0]?.input).toBe(1001);
    expect(sumTokens(merged[0] as UsageLine)).toBe(1001 + 2000 + 100_000 + 10_000);
  });

  it('adds a day up through the same pricing, and falls back to the SDK figure for a run kept without raw counts', () => {
    const priced = {
      sessionId: 's',
      accountId: null,
      purpose: null,
      finishedAt: 'f',
      runStartedAt: 'r',
      costUsd: 999,
      tokens: 1,
      lines,
    };
    const legacy = {
      sessionId: 't',
      accountId: null,
      purpose: null,
      finishedAt: 'f',
      runStartedAt: 'r',
      costUsd: 0.5,
      tokens: 1234,
      lines: null,
    };
    const day = totalOf([priced, legacy]);
    expect(day.cost_usd).toBeCloseTo(usageOfLines(lines, null).total.cost_usd + 0.5, 10);
    expect(day.tokens).toBe(1700 + 3300 + 150_000 + 15_000 + 1234);
    expect(day.runs).toBe(2);
  });
});

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

describe('usage of a real run', () => {
  const stateOf = (daemon: AgentDaemon, id: string, state: string) =>
    until(
      async () => (await api(daemon).get(`/sessions/${id}`)).body.data.state,
      (value) => value === state,
      state,
    );

  it('counts a message once however many times it is sent, and splits main from subagents', async () => {
    const daemon = await startAgentDaemon();
    running.push(daemon);
    const id = daemon.createSession();
    daemon.sdk.script(
      { task: { id: 't1', description: 'Finding 1' } },
      // The same message id three times: one per content block. Counted once.
      { usage: { id: 'm1', input: 1000, output: 500, cacheRead: 20_000, cacheWrite: 2000, repeat: 2 } },
      { usage: { id: 'm2', task: 't1', input: 400, output: 100, cacheRead: 10_000, repeat: 1 } },
      { usage: { id: 'm3', task: 't1', model: 'claude-haiku-5-5', input: 100, output: 50 } },
      { taskEnds: { id: 't1', status: 'completed' } },
      { cost: { usd: 12, tokens: 1 } },
      { text: 'ok' },
    );
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'go' });
    await stateOf(daemon, id, 'idle');

    const { run } = (await api(daemon).get(`/agent-runs/${id}`)).body.data;
    const main = (1000 * 3 + 500 * 15 + 20_000 * 0.3 + 2000 * 3.75) / M;
    const sub = (400 * 3 + 100 * 15 + 10_000 * 0.3) / M + (100 * 1 + 50 * 5) / M;
    expect(run.usage.main.tokens).toEqual({ input: 1000, output: 500, cache_read: 20_000, cache_write: 2000 });
    expect(run.usage.subagents.tokens).toEqual({ input: 500, output: 150, cache_read: 10_000, cache_write: 0 });
    expect(run.usage.main.cost_usd).toBeCloseTo(main, 10);
    expect(run.usage.subagents.cost_usd).toBeCloseTo(sub, 10);
    expect(run.usage.total.cost_usd).toBeCloseTo(main + sub, 10);
    expect(run.usage.by_agent.map((one: { agent_id: string | null }) => one.agent_id)).toEqual([null, 't1']);
    expect(run.usage.reported_cost_usd).toBe(12);
    expect(run.cost_usd).toBe(run.usage.total.cost_usd);
    expect(run.tokens).toBe(1000 + 500 + 20_000 + 2000 + 500 + 150 + 10_000);
    // The header's day total goes through the same pricing.
    const today = (await api(daemon).get('/agent-runs/usage')).body.data;
    expect(today).toEqual({ cost_usd: run.cost_usd, tokens: run.tokens, runs: 1 });
  });

  it('keeps what a run used when a usage limit ended it, and says when the limit began and resets', async () => {
    const daemon = await startAgentDaemon();
    running.push(daemon);
    const id = daemon.createSession();
    const resets = Math.floor(Date.now() / 1000) + 3600;
    const subs = Array.from({ length: 12 }, (_, i) => `t${i + 1}`);
    daemon.sdk.script(
      ...subs.map((task, i) => ({ task: { id: task, description: `Finding ${i + 1}` } })),
      ...subs.map((task, i) => ({ usage: { id: `m-${task}`, task, input: 100 * (i + 1), output: 10 } })),
      ...subs.slice(0, 9).map((task) => ({ taskEnds: { id: task, status: 'completed' as const } })),
      { taskEnds: { id: 't10', status: 'failed' } },
      { taskEnds: { id: 't11', status: 'failed' } },
      { rateLimitInfo: { status: 'rejected', resetsAt: resets } },
      { rejected: true },
    );
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'scan' });
    await stateOf(daemon, id, 'failed');

    const { run, failure, stages } = (await api(daemon).get(`/agent-runs/${id}`)).body.data;
    expect(run.subagents).toHaveLength(12);
    expect(run.usage.subagents.tokens.input).toBe(100 * ((12 * 13) / 2));
    expect(run.usage.main.tokens).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
    expect(run.limit).toEqual({ since: expect.any(String), resets_at: new Date(resets * 1000).toISOString() });
    expect(run.split.map((part: { phase: string }) => part.phase)).toEqual(Object.values(RunPhase));
    expect(run.split.find((part: { phase: string }) => part.phase === RunPhase.WaitingLimit)).toBeDefined();
    expect(failure).toMatchObject({
      kind: 'rate_limited',
      resets_at: new Date(resets * 1000).toISOString(),
      resume_point: 'Finding 10 (9 of 12 subagents finished)',
    });
    expect(stages.some((phase: { stopped: unknown }) => phase.stopped !== null)).toBe(true);
    // A new run clears the limit.
    daemon.sdk.script({ text: 'ok' });
    await api(daemon).post(`/sessions/${id}/messages`, { text: 'again' });
    await stateOf(daemon, id, 'idle');
    expect((await api(daemon).get(`/agent-runs/${id}`)).body.data.run.limit).toBeNull();
  });
});
