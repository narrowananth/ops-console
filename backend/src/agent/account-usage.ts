import { Inject, Injectable } from '@nestjs/common';
import {
  type AccountUsageQuery,
  type AccountUsageReport,
  type ClaudeAccount,
  SubagentStatus,
  type TokenCounts,
  UsageRange,
} from '@ops-console/shared';
import { inArray } from 'drizzle-orm';
import { AccountsService } from '../accounts/accounts.service';
import { sessions } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { addTokens, costOf, noTokens, sumTokens, type UsageLine } from './pricing';
import { type AgentRow, RunStepsLog, type UsageRow } from './run-steps';
import { costAndTokens } from './run-usage';

/** The runs listed under Top spenders. */
const TOP_RUNS = 25;
const NOT_ATTRIBUTED = 'Not attributed';
const REMOVED = 'Removed account';
const DAY_MS = 86_400_000;

/** What the page knows about a Session once its run ended: the title and kind the usage is grouped by. */
export type SessionFacts = { title: string; kind: string };

/** The machine's local day of an instant, `YYYY-MM-DD`. */
export function localDay(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}

const midnightOf = (day: string): Date => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
};

/** The first and last local day of a range, today included. */
export function rangeDays(range: UsageRange, now: Date): { from: string; to: string } {
  const to = localDay(now);
  if (range === UsageRange.Today) return { from: to, to };
  const back = range === UsageRange.Week ? 6 : range === UsageRange.Month ? 29 : 89;
  const start = midnightOf(to);
  start.setDate(start.getDate() - back);
  return { from: localDay(start), to };
}

function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = midnightOf(from);
  const last = midnightOf(to).getTime();
  while (cursor.getTime() <= last && days.length < 400) {
    days.push(localDay(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

type AgentFacts = AccountUsageReport['runs'][number]['agents'][number];

/**
 * One run's agents: the main agent, and each subagent the run started, from the subagent rows kept for the run and the
 * raw usage lines. A subagent that used no tokens still counts. A run kept without raw counts is one main agent.
 */
export function agentsOf(row: UsageRow, started: AgentRow[] = []): AgentFacts[] {
  const none = { parent_id: null, status: null, started_at: null, finished_at: null };
  if (row.lines === null && started.length === 0) {
    const one = costAndTokens(row);
    return [{ agent_id: null, ...none, type: null, description: null, tokens: one.tokens, cost_usd: one.cost_usd }];
  }
  const agents = new Map<string | null, AgentFacts>();
  const main: AgentFacts = { agent_id: null, ...none, type: null, description: null, tokens: 0, cost_usd: 0 };
  agents.set(null, main);
  for (const task of started) {
    agents.set(task.taskId, {
      agent_id: task.taskId,
      parent_id: task.parentId,
      type: task.type,
      description: task.description,
      status: task.status as SubagentStatus,
      started_at: task.startedAt,
      finished_at: task.finishedAt,
      tokens: 0,
      cost_usd: 0,
    });
  }
  for (const line of (row.lines ?? []) as UsageLine[]) {
    const had = agents.get(line.agent_id) ?? {
      agent_id: line.agent_id,
      ...none,
      type: line.agent_type ?? null,
      description: line.agent_description ?? null,
      tokens: 0,
      cost_usd: 0,
    };
    had.type ??= line.agent_type ?? null;
    had.description ??= line.agent_description ?? null;
    had.tokens += sumTokens(line);
    had.cost_usd += costOf(line, line.model);
    agents.set(line.agent_id, had);
  }
  if (row.lines === null) {
    const one = costAndTokens(row);
    main.tokens = one.tokens;
    main.cost_usd = one.cost_usd;
  }
  return [...agents.values()];
}

const tokensIn = (row: UsageRow): TokenCounts =>
  (row.lines ?? []).reduce((total, line) => addTokens(total, line), noTokens());

type Bucket = { tokens: number; cost_usd: number; runs: number; subagents: number };
const empty = (): Bucket => ({ tokens: 0, cost_usd: 0, runs: 0, subagents: 0 });

/** The accounts, local days, work and agents the rows add up to. Pure: the service reads the rows and accounts. */
export function accountUsageOf(input: {
  rows: UsageRow[];
  /** The subagents the runs started, from `run_agents`. */
  agents?: AgentRow[];
  sessions: Map<string, SessionFacts>;
  accounts: Pick<ClaudeAccount, 'id' | 'label' | 'email' | 'enabled' | 'position'>[];
  query: AccountUsageQuery;
  now: Date;
}): AccountUsageReport {
  const { sessions: facts, accounts, query, now } = input;
  const known = new Set(accounts.map((account) => account.id));
  const startedBy = new Map<string, AgentRow[]>();
  for (const task of input.agents ?? []) {
    const key = `${task.sessionId}\u0000${task.runStartedAt}`;
    startedBy.set(key, [...(startedBy.get(key) ?? []), task]);
  }
  const only = query.account === undefined ? undefined : query.account === 'none' ? null : query.account;
  const finishedDay = (row: UsageRow, finished: Map<UsageRow, string>) => finished.get(row) ?? '';
  const finished = new Map<UsageRow, string>();
  for (const row of input.rows) finished.set(row, localDay(new Date(row.finishedAt)));
  const { from, to } = rangeDays(query.range, now);
  const rows = input.rows.filter((row) => {
    const day = finishedDay(row, finished);
    return day >= from && day <= to && (only === undefined || row.accountId === only);
  });

  const totals = { tokens: noTokens(), total_tokens: 0, cost_usd: 0, runs: 0, subagents: 0 };
  const days = new Map(
    eachDay(from, to).map((date) => [
      date,
      {
        date,
        cost_usd: 0,
        tokens: 0,
        runs: 0,
        byAccount: new Map<string | null, number>(),
        byWork: new Map<string, number>(),
      },
    ]),
  );
  const byAccount = new Map<string | null, Bucket>();
  const byWork = new Map<string, Bucket>();
  const byType = new Map<
    string,
    {
      type: string | null;
      main: boolean;
      tokens: number;
      cost_usd: number;
      agents: number;
      failed: number;
      timed: number[];
    }
  >();
  const runs: AccountUsageReport['runs'] = [];

  for (const row of rows) {
    const { cost_usd, tokens } = costAndTokens(row);
    const agents = agentsOf(row, startedBy.get(`${row.sessionId}\u0000${row.runStartedAt}`));
    const subagents = agents.filter((agent) => agent.agent_id !== null).length;
    const kind = facts.get(row.sessionId)?.kind ?? 'unknown';
    // A run kept before purposes were recorded knows only its Session's kind.
    const work = row.purpose ?? `kind:${kind}`;
    totals.tokens = addTokens(totals.tokens, tokensIn(row));
    totals.total_tokens += tokens;
    totals.cost_usd += cost_usd;
    totals.runs += 1;
    totals.subagents += subagents;

    const day = days.get(finishedDay(row, finished));
    if (day) {
      day.cost_usd += cost_usd;
      day.tokens += tokens;
      day.runs += 1;
      day.byAccount.set(row.accountId, (day.byAccount.get(row.accountId) ?? 0) + cost_usd);
      day.byWork.set(work, (day.byWork.get(work) ?? 0) + cost_usd);
    }
    const account = byAccount.get(row.accountId) ?? empty();
    account.tokens += tokens;
    account.cost_usd += cost_usd;
    account.runs += 1;
    account.subagents += subagents;
    byAccount.set(row.accountId, account);
    const workBucket = byWork.get(work) ?? empty();
    workBucket.tokens += tokens;
    workBucket.cost_usd += cost_usd;
    workBucket.runs += 1;
    workBucket.subagents += subagents;
    byWork.set(work, workBucket);

    for (const agent of agents) {
      const main = agent.agent_id === null;
      const key = main ? '\u0000main' : (agent.type ?? '\u0000untyped');
      const bucket = byType.get(key) ?? {
        type: main ? null : agent.type,
        main,
        tokens: 0,
        cost_usd: 0,
        agents: 0,
        failed: 0,
        timed: [] as number[],
      };
      if (agent.status === SubagentStatus.Failed) bucket.failed += 1;
      if (agent.started_at && agent.finished_at) {
        bucket.timed.push(Date.parse(agent.finished_at) - Date.parse(agent.started_at));
      }
      bucket.tokens += agent.tokens;
      bucket.cost_usd += agent.cost_usd;
      bucket.agents += 1;
      byType.set(key, bucket);
    }
    runs.push({
      session_id: row.sessionId,
      title: facts.get(row.sessionId)?.title ?? 'Session',
      kind,
      work,
      account_id: row.accountId,
      finished_at: row.finishedAt,
      tokens,
      cost_usd,
      subagents,
      agents,
    });
  }

  const labelOf = (id: string | null) => {
    if (id === null) return NOT_ATTRIBUTED;
    const account = accounts.find((one) => one.id === id);
    return account ? (account.email ?? account.label) : REMOVED;
  };
  // Every account shows, spending or not; accounts removed since, and runs with no account, only when they have runs.
  const listed: (string | null)[] =
    only !== undefined
      ? [only]
      : [
          ...[...accounts].sort((a, b) => a.position - b.position).map((account) => account.id),
          ...[...byAccount.keys()].filter((id) => id !== null && !known.has(id)),
          ...(byAccount.has(null) ? [null] : []),
        ];
  const accountRows = [...new Set(listed)].map((id) => ({
    account_id: id,
    label: labelOf(id),
    removed: id !== null && !known.has(id),
    enabled: id === null || !known.has(id) ? true : (accounts.find((one) => one.id === id)?.enabled ?? true),
    ...(byAccount.get(id) ?? empty()),
  }));

  return {
    range: query.range,
    account_id: only ?? null,
    from,
    to,
    totals,
    days: [...days.values()].map((day) => ({
      date: day.date,
      cost_usd: day.cost_usd,
      tokens: day.tokens,
      runs: day.runs,
      by_account: [...day.byAccount].map(([account_id, cost]) => ({ account_id, cost_usd: cost })),
      by_work: [...day.byWork].map(([work, cost]) => ({ work, cost_usd: cost })),
    })),
    accounts: accountRows,
    work: [...byWork].map(([work, bucket]) => ({ work, ...bucket })).sort((a, b) => b.cost_usd - a.cost_usd),
    subagent_types: [...byType.values()]
      .map(({ timed, ...type }) => ({
        ...type,
        avg_ms: timed.length === 0 ? null : Math.round(timed.reduce((sum, ms) => sum + ms, 0) / timed.length),
      }))
      .sort((a, b) => b.cost_usd - a.cost_usd),
    runs: runs.sort((a, b) => b.cost_usd - a.cost_usd).slice(0, TOP_RUNS),
  };
}

/** Reads what the console recorded for each Claude account: tokens, estimated cost, runs and subagents. */
@Injectable()
export class AccountUsage {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(RunStepsLog) private readonly log: RunStepsLog,
    @Inject(AccountsService) private readonly accounts: AccountsService,
  ) {}

  read(query: AccountUsageQuery, now = new Date()): AccountUsageReport {
    // Rows a day wider than the range at both ends, so the machine's days decide, not the UTC ones.
    const since = new Date(now.getTime() - 92 * DAY_MS).toISOString();
    const rows = this.log.usageRowsSince(since);
    const agents = this.log.agentsSince(since);
    const ids = [...new Set(rows.map((row) => row.sessionId))];
    const known = ids.length === 0 ? [] : this.store.db.select().from(sessions).where(inArray(sessions.id, ids)).all();
    return accountUsageOf({
      rows,
      agents,
      sessions: new Map(known.map((row) => [row.id, { title: row.title, kind: row.kind }])),
      accounts: this.accounts.list().data,
      query,
      now,
    });
  }
}
