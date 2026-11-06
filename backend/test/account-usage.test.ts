import path from 'node:path';
import { SubagentStatus, UsageRange } from '@ops-console/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { accountUsageOf, agentsOf, localDay, rangeDays } from '../src/agent/account-usage';
import type { UsageLine } from '../src/agent/pricing';
import { costOf, sumTokens } from '../src/agent/pricing';
import type { UsageRow } from '../src/agent/run-steps';
import { type AgentDaemon, api, converse, signIn, startAgentDaemon } from './agent-fixtures';

const now = new Date(2026, 10, 6, 15, 0, 0);
const at = (day: number, hour = 10) => new Date(2026, 10, day, hour, 0, 0).toISOString();

const line = (agent: string | null, input: number, extra: Partial<UsageLine> = {}): UsageLine => ({
  agent_id: agent,
  model: 'claude-sonnet-5-5',
  input,
  output: 100,
  cache_read: 1000,
  cache_write: 0,
  ...extra,
});

const row = (
  id: string,
  account: string | null,
  day: number,
  lines: UsageLine[] | null,
  purpose: string | null = null,
): UsageRow => ({
  sessionId: id,
  accountId: account,
  purpose,
  runStartedAt: at(day, 9),
  finishedAt: at(day),
  costUsd: 99,
  tokens: 777,
  lines,
});

const accounts = [
  { id: 'a1', label: 'ops@example.com', email: 'ops@example.com', enabled: true, position: 1 },
  { id: 'a2', label: 'sam@example.com', email: 'sam@example.com', enabled: false, position: 2 },
];

const sessions = new Map([
  ['s1', { title: 'Fix cart', kind: 'repo' }],
  ['s2', { title: 'Review 12', kind: 'pr_review' }],
  ['s3', { title: 'Old run', kind: 'repo' }],
]);

describe('the ranges of account usage', () => {
  it('counts the machine’s local days: today, 7, 30 and 90, and no longer', () => {
    expect(localDay(now)).toBe('2026-11-06');
    expect(rangeDays(UsageRange.Today, now)).toEqual({ from: '2026-11-06', to: '2026-11-06' });
    expect(rangeDays(UsageRange.Week, now)).toEqual({ from: '2026-10-31', to: '2026-11-06' });
    expect(rangeDays(UsageRange.Month, now)).toEqual({ from: '2026-10-08', to: '2026-11-06' });
    expect(rangeDays(UsageRange.Quarter, now)).toEqual({ from: '2026-08-09', to: '2026-11-06' });
    expect(Object.values(UsageRange)).toEqual(['today', '7d', '30d', '90d']);
  });
});

describe('what the rows add up to', () => {
  const rows = [
    row('s1', 'a1', 6, [
      line(null, 5000),
      line('t1', 2000, { agent_type: 'Explore', agent_description: 'Find reducers' }),
    ]),
    row('s2', 'a2', 5, [line(null, 1000)]),
    row('s3', null, 6, null),
    row('s1', 'gone', 3, [line(null, 300)]),
    row('s1', 'a1', -9, [line(null, 10)]),
  ];
  const report = (query: { range?: UsageRange; account?: string } = {}) =>
    accountUsageOf({ rows, sessions, accounts, query: { range: UsageRange.Week, ...query }, now });

  it('adds days, accounts and kinds up to the same totals', () => {
    const all = report();
    const costs = rows
      .slice(0, 4)
      .map((one) => (one.lines ?? []).reduce((sum, one2) => sum + costOf(one2, one2.model), 0));
    expect(all.totals.runs).toBe(4);
    expect(all.totals.subagents).toBe(1);
    const sum = (values: number[]) => values.reduce((total, one) => total + one, 0);
    expect(sum(all.days.map((day) => day.cost_usd))).toBeCloseTo(all.totals.cost_usd, 8);
    expect(sum(all.accounts.map((one) => one.cost_usd))).toBeCloseTo(all.totals.cost_usd, 8);
    expect(sum(all.work.map((one) => one.cost_usd))).toBeCloseTo(all.totals.cost_usd, 8);
    expect(sum(all.subagent_types.map((one) => one.cost_usd))).toBeCloseTo(all.totals.cost_usd, 8);
    expect(all.days).toHaveLength(7);
    expect(all.totals.total_tokens).toBe(
      rows
        .slice(0, 4)
        .reduce((total, one) => total + (one.lines ? one.lines.reduce((s, l) => s + sumTokens(l), 0) : 777), 0),
    );
  });

  it('groups runs by what they were for, and a run from before purposes by its Session’s kind', () => {
    const work = accountUsageOf({
      rows: [
        row('s1', 'a1', 6, [line(null, 100), line('t1', 50)], 'fix'),
        row('s1', 'a1', 6, [line(null, 100)], 'chat'),
        row('s2', 'a2', 5, [line(null, 100)], null),
        row('s3', null, 6, null),
      ],
      sessions,
      accounts,
      query: { range: UsageRange.Week },
      now,
    });
    expect(work.work.map((one) => [one.work, one.runs, one.subagents]).sort()).toEqual([
      ['chat', 1, 0],
      ['fix', 1, 1],
      ['kind:pr_review', 1, 0],
      ['kind:repo', 1, 0],
    ]);
    expect(work.runs.find((one) => one.session_id === 's2')?.work).toBe('kind:pr_review');
    expect(
      work.days
        .at(-1)
        ?.by_work.map((one) => one.work)
        .sort(),
    ).toEqual(['chat', 'fix', 'kind:repo']);
  });

  it('lists every account, the removed ones, and runs with none, in that order', () => {
    expect(report().accounts.map((one) => [one.label, one.removed, one.enabled, one.runs])).toEqual([
      ['ops@example.com', false, true, 1],
      ['sam@example.com', false, false, 1],
      ['Removed account', true, true, 1],
      ['Not attributed', false, true, 1],
    ]);
  });

  it('shows one account only, or the runs with no account', () => {
    const one = report({ account: 'a1' });
    expect(one.accounts.map((entry) => entry.account_id)).toEqual(['a1']);
    expect(one.totals.runs).toBe(1);
    expect(one.runs.map((entry) => entry.session_id)).toEqual(['s1']);
    const none = report({ account: 'none' });
    expect(none.accounts.map((entry) => entry.label)).toEqual(['Not attributed']);
    expect(none.totals.runs).toBe(1);
  });

  it('keeps the range: Today holds today’s run only, 30 days adds the earlier one', () => {
    expect(report({ range: UsageRange.Today }).totals.runs).toBe(2);
    expect(report({ range: UsageRange.Month }).totals.runs).toBe(5);
    expect(report({ range: UsageRange.Today }).days.map((day) => day.date)).toEqual(['2026-11-06']);
  });

  it('splits agents by type, with main agents and untyped lines on their own', () => {
    const types = report().subagent_types.map((one) => [one.type, one.main, one.agents]);
    expect(types).toContainEqual(['Explore', false, 1]);
    expect(types).toContainEqual([null, true, 4]);
  });

  it('opens a run to its main agent and subagents, and prices a run kept without raw counts as one main agent', () => {
    const top = report().runs.find((one) => one.session_id === 's1' && one.account_id === 'a1');
    expect(top?.agents.map((agent) => [agent.agent_id, agent.type, agent.description])).toEqual([
      [null, null, null],
      ['t1', 'Explore', 'Find reducers'],
    ]);
    expect(agentsOf(rows[2] as UsageRow)).toEqual([
      {
        agent_id: null,
        parent_id: null,
        type: null,
        description: null,
        status: null,
        started_at: null,
        finished_at: null,
        tokens: 777,
        cost_usd: 99,
      },
    ]);
  });

  it('counts a subagent that used no tokens, nests it, and says how each ended and how long it took', () => {
    const task = (id: string, parent: string | null, type: string, status: SubagentStatus, seconds: number | null) => ({
      id: `r-${id}`,
      sessionId: 's1',
      runStartedAt: at(6, 9),
      taskId: id,
      parentId: parent,
      type,
      description: `Task ${id}`,
      status,
      startedAt: at(6, 9),
      finishedAt: seconds === null ? null : new Date(new Date(at(6, 9)).getTime() + seconds * 1000).toISOString(),
    });
    const withAgents = accountUsageOf({
      rows: [row('s1', 'a1', 6, [line(null, 100), line('t1', 50)])],
      agents: [
        task('t1', null, 'Explore', SubagentStatus.Done, 30),
        task('t2', 't1', 'Explore', SubagentStatus.Failed, 90),
        task('t3', null, 'general-purpose', SubagentStatus.Stopped, null),
      ],
      sessions,
      accounts,
      query: { range: UsageRange.Week },
      now,
    });
    expect(withAgents.totals.subagents).toBe(3);
    const explore = withAgents.subagent_types.find((one) => one.type === 'Explore');
    expect(explore).toMatchObject({ agents: 2, failed: 1, avg_ms: 60_000 });
    expect(withAgents.subagent_types.find((one) => one.type === 'general-purpose')).toMatchObject({
      agents: 1,
      failed: 0,
      avg_ms: null,
    });
    const agents = withAgents.runs[0]?.agents ?? [];
    expect(agents.map((agent) => [agent.agent_id, agent.parent_id, agent.status])).toEqual([
      [null, null, null],
      ['t1', null, 'done'],
      ['t2', 't1', 'failed'],
      ['t3', null, 'stopped'],
    ]);
    expect(agents.find((agent) => agent.agent_id === 't1')?.tokens).toBeGreaterThan(0);
    expect(agents.find((agent) => agent.agent_id === 't2')?.tokens).toBe(0);
  });

  it('is empty, with every day of the range at zero, when nothing ran', () => {
    const empty = accountUsageOf({ rows: [], sessions, accounts, query: { range: UsageRange.Week }, now });
    expect(empty.totals).toMatchObject({ runs: 0, cost_usd: 0, total_tokens: 0 });
    expect(empty.days).toHaveLength(7);
    expect(empty.accounts.map((one) => one.label)).toEqual(['ops@example.com', 'sam@example.com']);
  });
});

const running: AgentDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

describe('account usage from real runs', () => {
  it('counts a run for the account it ended on, with its subagent, and the day total agrees', async () => {
    const daemon = await startAgentDaemon();
    running.push(daemon);
    const added = await api(daemon).post('/agent-accounts');
    const personal = added.body.data.account.id;
    await signIn(path.join(daemon.dataDir, 'accounts', personal), 'personal@example.com', 'pro');
    await api(daemon).post(`/agent-accounts/${personal}/checks`);
    const id = daemon.createSession();
    daemon.sdk.script(
      { task: { id: 't1', description: 'Find reducers', type: 'Explore' } },
      { usage: { id: 'm1', input: 1000, output: 100 } },
      { usage: { id: 'm2', task: 't1', input: 4000, output: 400 } },
      { text: 'done' },
    );
    await converse(daemon, id, 'go');
    await api(daemon).post(`/agent-accounts/${personal}/activate`);
    daemon.sdk.script({ usage: { id: 'm3', input: 500, output: 50 } }, { text: 'again' });
    await converse(daemon, daemon.createSession(), 'next');

    const report = (await api(daemon).get('/agent-accounts/usage?range=7d')).body.data;
    const first = report.accounts.find((one: { label: string }) => one.label === 'operator@example.com');
    const second = report.accounts.find((one: { label: string }) => one.label === 'personal@example.com');
    expect(first).toMatchObject({ runs: 1, subagents: 1 });
    expect(second).toMatchObject({ runs: 1, subagents: 0 });
    expect(report.subagent_types.find((one: { type: string | null }) => one.type === 'Explore')).toMatchObject({
      agents: 1,
    });
    const today = (await api(daemon).get('/agent-runs/usage')).body.data;
    expect(report.totals.cost_usd).toBeCloseTo(today.cost_usd, 8);
    expect(report.totals.total_tokens).toBe(today.tokens);
    expect(report.work.map((one: { work: string; runs: number }) => [one.work, one.runs])).toEqual([['chat', 2]]);
    expect((await api(daemon).get('/agent-accounts/usage?range=year')).status).toBe(400);
  });

  it('keeps every subagent of a run, nested ones too, with how each ended; one still going when the run ends ends with it', async () => {
    const daemon = await startAgentDaemon();
    running.push(daemon);
    const id = daemon.createSession();
    daemon.sdk.script(
      { task: { id: 't1', description: 'Find reducers', type: 'Explore' } },
      { task: { id: 't2', description: 'Read the store', type: 'Explore', parent: 't1' } },
      { task: { id: 't3', description: 'Write the test', type: 'general-purpose' } },
      { usage: { id: 'm1', input: 100, output: 10 } },
      { usage: { id: 'm2', task: 't1', input: 400, output: 40 } },
      { taskEnds: { id: 't2', status: 'failed' } },
      { taskEnds: { id: 't1', status: 'completed' } },
      { text: 'done' },
    );
    await converse(daemon, id, 'go');

    const report = (await api(daemon).get('/agent-accounts/usage?range=today')).body.data;
    expect(report.totals.subagents).toBe(3);
    const types = Object.fromEntries(
      report.subagent_types.map((one: { type: string | null; agents: number; failed: number }) => [one.type, one]),
    );
    expect(types.Explore).toMatchObject({ agents: 2, failed: 1 });
    expect(types['general-purpose']).toMatchObject({ agents: 1, failed: 0 });
    const agents = report.runs[0].agents as {
      agent_id: string | null;
      parent_id: string | null;
      status: string | null;
      finished_at: string | null;
      tokens: number;
    }[];
    const by = (task: string) => agents.find((one) => one.agent_id === task);
    expect(by('t2')).toMatchObject({ parent_id: 't1', status: 'failed' });
    expect(by('t1')).toMatchObject({ status: 'done' });
    expect(by('t3')).toMatchObject({ status: 'done' });
    expect(by('t3')?.finished_at).not.toBeNull();
    expect(by('t1')?.tokens).toBe(440);
    expect(by('t3')?.tokens).toBe(0);
  });
});
