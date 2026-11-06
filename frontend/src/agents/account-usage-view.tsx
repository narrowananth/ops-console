import {
  type AccountUsageReport,
  type ClaudeAccount,
  RunPurpose,
  SubagentStatus,
  UsageRange,
} from '@ops-console/shared';
import { type CSSProperties, Fragment, type ReactNode, useState } from 'react';
import { money, tokens } from '../agent-runs/run-look';
import { Button } from '../components/ui/button';
import { duration } from '../components/ui/elapsed';
import { useAccountUsage, useAgentAccounts, useCliProxy } from '../lib/queries';
import { ascending } from '../lib/sort';
import { AllDisabledBanner, allDisabled } from './account-switch';
import { UsageBar } from './usage-bar';

const RANGES = [
  { id: UsageRange.Today, label: 'Today', phrase: 'today' },
  { id: UsageRange.Week, label: '7 days', phrase: 'in the last 7 days' },
  { id: UsageRange.Month, label: '30 days', phrase: 'in the last 30 days' },
  { id: UsageRange.Quarter, label: '90 days', phrase: 'in the last 90 days' },
] as const;

/** What each kind of work is called, and in one line what it is. `kind:` entries are runs kept before purposes were. */
const WORK: Record<string, { label: string; text: string }> = {
  [RunPurpose.Chat]: { label: 'Your messages (chat)', text: 'Messages you send an agent in a Session' },
  [RunPurpose.Verify]: {
    label: 'Monitor Verify',
    text: 'Agent checks an Alert against the code and reports whether it holds',
  },
  [RunPurpose.Fix]: { label: 'Monitor Fix', text: 'Agent fixes a verified Alert and opens a pull request' },
  [RunPurpose.CommentPass]: {
    label: 'Comment pass',
    text: 'Agent works through review comments on a pull request',
  },
  [RunPurpose.ReplyCheck]: {
    label: 'Reply check',
    text: 'Agent reads the replies on review threads and says which are settled',
  },
  [RunPurpose.AgentReview]: { label: 'Agent Review', text: 'Agent reviews a pull request and leaves its findings' },
  [RunPurpose.OpenPullRequest]: {
    label: 'Open pull request',
    text: 'Agent writes the title and description and opens a pull request',
  },
  playbook: { label: 'Playbook step', text: 'Agent follows one step of a Playbook' },
  'kind:pr_review': {
    label: 'Agent review (earlier runs)',
    text: 'Pull request reviews kept before purposes were recorded',
  },
  'kind:repo': { label: 'Repo session (earlier runs)', text: 'Repo Sessions kept before purposes were recorded' },
  'kind:devtools': { label: 'Dev tools (earlier runs)', text: 'Dev tools Sessions kept before purposes were recorded' },
  'kind:anonymous': {
    label: 'Anonymous session (earlier runs)',
    text: 'Anonymous Sessions kept before purposes were recorded',
  },
};
const workLabel = (work: string) => WORK[work]?.label ?? work;
const workText = (work: string) => WORK[work]?.text;

/** What a mark is painted with: a Tailwind class, or a style for the hatched grey of runs with no account. */
type Paint = { className?: string; style?: CSSProperties };
const PALETTE = ['bg-neutral-800', 'bg-accent', 'bg-warn', 'bg-info', 'bg-ok', 'bg-accent-2'];
const HATCHED: Paint = {
  style: {
    backgroundImage:
      'repeating-linear-gradient(45deg, var(--color-neutral-500) 0 3px, var(--color-neutral-300) 3px 6px)',
  },
};
const REMOVED: Paint = { className: 'bg-neutral-500' };

/** Colour by place in the sorted account list, so a chip, a bar and a table row of one account always match. */
const accountPaint = (id: string | null, order: string[]): Paint => {
  if (id === null) return HATCHED;
  const at = order.indexOf(id);
  return at < 0 ? REMOVED : { className: PALETTE[at % PALETTE.length] };
};

function Swatch({ paint, className = 'size-2' }: { paint: Paint; className?: string }) {
  return (
    <i
      aria-hidden
      className={`inline-block flex-none rounded-full ring-1 ring-card/40 ${className} ${paint.className ?? ''}`}
      style={paint.style}
    />
  );
}

const rangeOf = (value: string | null): UsageRange => RANGES.find((one) => one.id === value)?.id ?? UsageRange.Week;

/** `Thu 6`, from a local `YYYY-MM-DD`. */
function dayLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const at = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  return `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${at.getDate()}`;
}

const card = 'rounded-xl border border-line bg-card shadow-sm';
const heading = 'm-0 text-[15px]';

function Block({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="mt-6">
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <h2 className={heading}>{title}</h2>
        {sub && <span className="text-xs text-neutral-700">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <section aria-label={label} className={`${card} px-4 py-3`}>
      <div className="text-xs text-neutral-700">{label}</div>
      <div className="mt-0.5 font-mono text-xl font-bold">{value}</div>
      <div className="mt-0.5 text-xs text-neutral-700">{sub}</div>
    </section>
  );
}

function Figures({ report }: { report: AccountUsageReport }) {
  const { totals } = report;
  const cache = totals.tokens.cache_read + totals.tokens.cache_write;
  const perDay = totals.runs / Math.max(report.days.length, 1);
  return (
    <div className="mt-4 grid grid-cols-2 gap-2.5 md:grid-cols-4">
      <Figure
        label="Tokens"
        value={tokens(totals.total_tokens)}
        sub={`in ${tokens(totals.tokens.input)} · out ${tokens(totals.tokens.output)} · cache ${tokens(cache)}`}
      />
      <Figure label="Estimated cost" value={money(totals.cost_usd)} sub="at API prices, not billed" />
      <Figure
        label="Agent runs"
        value={String(totals.runs)}
        sub={`${perDay >= 10 ? Math.round(perDay) : perDay.toFixed(1)} a day on average`}
      />
      <Figure
        label="Subagents"
        value={String(totals.subagents)}
        sub={totals.runs === 0 ? '—' : `${(totals.subagents / totals.runs).toFixed(1)} per run`}
      />
    </div>
  );
}

type Series = { key: string; label: string; paint: Paint };

function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="m-0 mt-3 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-neutral-700">
      {series.map((one) => (
        <li key={one.key} className="flex items-center gap-1.5">
          <Swatch paint={one.paint} />
          {one.label}
        </li>
      ))}
    </ul>
  );
}

/** One column per local day, its cost split by account (all accounts) or by kind of work (one account). */
function DayChart({
  report,
  oneAccount,
  order,
  accountLabel,
}: {
  report: AccountUsageReport;
  oneAccount: boolean;
  order: string[];
  accountLabel: (id: string | null) => string;
}) {
  const workPaint = (work: string): Paint => {
    const at = report.work.findIndex((one) => one.work === work);
    return { className: PALETTE[Math.max(at, 0) % PALETTE.length] };
  };
  const series: Series[] = oneAccount
    ? report.work.map((one) => ({ key: one.work, label: workLabel(one.work), paint: workPaint(one.work) }))
    : report.accounts
        .filter((one) => one.runs > 0)
        .map((one) => ({
          key: String(one.account_id),
          label: one.label,
          paint: accountPaint(one.account_id, order),
        }));
  const peak = report.days.reduce<(typeof report.days)[number] | undefined>(
    (best, day) => (best === undefined || day.cost_usd > best.cost_usd ? day : best),
    undefined,
  );
  const max = Math.max(peak?.cost_usd ?? 0, 0.0001);
  const total = report.totals.cost_usd;
  const average = total / Math.max(report.days.length, 1);
  const crowded = report.days.length > 14;
  // Many days: a label every few columns, and always today's.
  const every = Math.ceil(report.days.length / 10);
  const seriesCost = (key: string) =>
    report.days.reduce(
      (sum, day) =>
        sum +
        (oneAccount ? day.by_work : day.by_account).reduce(
          (inner, one) => inner + (('work' in one ? one.work : String(one.account_id)) === key ? one.cost_usd : 0),
          0,
        ),
      0,
    );
  return (
    <div className={`${card} px-5 pt-4 pb-4`}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <div>
          <div className="font-mono text-xl font-bold">{money(total)}</div>
          <div className="text-[11px] text-neutral-700">in this range</div>
        </div>
        <div>
          <div className="font-mono text-sm font-semibold">{money(average)}</div>
          <div className="text-[11px] text-neutral-700">a day on average</div>
        </div>
        {peak && peak.cost_usd > 0 && (
          <div>
            <div className="font-mono text-sm font-semibold">{money(peak.cost_usd)}</div>
            <div className="text-[11px] text-neutral-700">peak, {dayLabel(peak.date)}</div>
          </div>
        )}
      </div>
      <div className="relative pl-12">
        {[1, 0.5, 0].map((at) => (
          <div
            key={at}
            aria-hidden
            className="absolute right-0 left-0 flex items-center gap-2"
            style={{ bottom: `calc(1.5rem + ${at} * (100% - 1.5rem - 1.25rem))` }}
          >
            <span className="w-10 text-right font-mono text-[10px] text-neutral-500">{money(max * at)}</span>
            <span className={`h-px flex-1 ${at === 0 ? 'bg-divider' : 'border-t border-dashed border-line'}`} />
          </div>
        ))}
        <div role="img" aria-label="Cost per day" className="relative flex h-60 items-end gap-1.5">
          {report.days.map((day, index) => {
            const parts = oneAccount
              ? day.by_work.map((one) => ({
                  key: one.work,
                  label: workLabel(one.work),
                  cost: one.cost_usd,
                  paint: workPaint(one.work),
                }))
              : day.by_account.map((one) => ({
                  key: String(one.account_id),
                  label: accountLabel(one.account_id),
                  cost: one.cost_usd,
                  paint: accountPaint(one.account_id, order),
                }));
            const today = day.date === report.to;
            return (
              <div
                key={day.date}
                title={`${dayLabel(day.date)}: ${money(day.cost_usd)}, ${day.runs} runs${parts.map((one) => `\n${one.label} ${money(one.cost)}`).join('')}`}
                className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end"
              >
                <div className="flex w-full flex-1 flex-col items-center justify-end pb-6">
                  {!crowded && day.cost_usd > 0 && (
                    <span className="mb-1 font-mono text-[10px] font-semibold text-neutral-800">
                      {money(day.cost_usd)}
                    </span>
                  )}
                  <div
                    className={`flex w-full max-w-16 flex-col-reverse overflow-hidden rounded-t-md transition-[filter] group-hover:brightness-110 ${
                      today ? 'ring-2 ring-accent/30' : ''
                    }`}
                    style={{
                      height:
                        day.cost_usd === 0 ? '2px' : `${Math.max((day.cost_usd / max) * (crowded ? 100 : 86), 1.5)}%`,
                      ...(day.cost_usd === 0 ? { backgroundColor: 'var(--color-neutral-300)' } : {}),
                    }}
                  >
                    {parts.map((one) => (
                      <i
                        key={one.key}
                        className={`block ${one.paint.className ?? ''}`}
                        style={{
                          ...one.paint.style,
                          height: `${day.cost_usd === 0 ? 0 : (one.cost / day.cost_usd) * 100}%`,
                        }}
                      />
                    ))}
                  </div>
                </div>
                <span
                  className={`absolute bottom-0 h-5 text-[10px] whitespace-nowrap ${
                    today ? 'font-bold text-text' : 'text-neutral-700'
                  }`}
                >
                  {crowded
                    ? today
                      ? 'today'
                      : index % every === 0
                        ? dayLabel(day.date)
                        : ''
                    : `${dayLabel(day.date)}${today ? ' · today' : ''}`}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <ul className="m-0 mt-3 flex list-none flex-wrap gap-2 border-t border-line p-0 pt-3 text-xs">
        {series.map((one) => {
          const cost = seriesCost(one.key);
          return (
            <li key={one.key} className="flex items-center gap-1.5 rounded-full bg-bg px-2.5 py-1 text-neutral-800">
              <Swatch paint={one.paint} />
              {one.label}
              <span className="font-mono text-neutral-700">
                {money(cost)}
                {total > 0 && ` · ${Math.round((cost / total) * 100)}%`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Pill({ children, tone }: { children: string; tone: 'ok' | 'off' }) {
  return (
    <span
      className={`rounded-full px-2 py-px text-[10px] font-semibold ${tone === 'ok' ? 'bg-ok/12 text-ok' : 'bg-neutral-200 text-neutral-700'}`}
    >
      {children}
    </span>
  );
}

const th = 'px-3 py-2 text-right text-[10px] font-bold tracking-wide text-neutral-700 uppercase first:text-left';
const td = 'px-3 py-2 text-right font-mono text-xs first:text-left first:font-sans first:text-[12.5px]';

/** Who spent the credit: a share bar, then one row per account with the totals under it. */
function AccountTable({
  report,
  order,
  activeId,
}: {
  report: AccountUsageReport;
  order: string[];
  activeId: string | null;
}) {
  const total = report.totals.cost_usd;
  const rows = [
    ...ascending(
      report.accounts.filter((one) => one.account_id !== null && !one.removed),
      (one) => one.label,
    ),
    ...report.accounts.filter((one) => one.removed),
    ...report.accounts.filter((one) => one.account_id === null),
  ];
  const share = (cost: number) => (total === 0 ? 0 : (cost / total) * 100);
  return (
    <div className={`${card} overflow-hidden`}>
      <div className="flex h-3.5 gap-px bg-neutral-200" role="img" aria-label="Share of cost by account">
        {rows
          .filter((one) => one.cost_usd > 0)
          .map((one) => (
            <i
              key={String(one.account_id)}
              title={`${one.label}: ${share(one.cost_usd).toFixed(0)}%`}
              className={`block ${accountPaint(one.account_id, order).className ?? ''}`}
              style={{ ...accountPaint(one.account_id, order).style, width: `${share(one.cost_usd)}%` }}
            />
          ))}
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line">
            <th className={th}>Account</th>
            <th className={th}>Share</th>
            <th className={th}>Tokens</th>
            <th className={th}>Cost</th>
            <th className={th}>Runs</th>
            <th className={th}>Subagents</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((one) => (
            <tr key={String(one.account_id)} className="border-t border-line first:border-t-0">
              <td className={td}>
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Swatch paint={accountPaint(one.account_id, order)} />
                  {one.label}
                  {one.account_id !== null && one.account_id === activeId && one.enabled && (
                    <Pill tone="ok">ACTIVE</Pill>
                  )}
                  {one.account_id !== null && !one.removed && !one.enabled && <Pill tone="off">DISABLED</Pill>}
                  {one.account_id === null && (
                    <span className="text-[11px] text-neutral-700">runs before accounts were tracked</span>
                  )}
                </span>
              </td>
              <td className={td}>{share(one.cost_usd).toFixed(0)}%</td>
              <td className={td}>{tokens(one.tokens)}</td>
              <td className={td}>{money(one.cost_usd)}</td>
              <td className={td}>{one.runs}</td>
              <td className={td}>{one.subagents}</td>
            </tr>
          ))}
          <tr className="border-t border-divider font-bold">
            <td className={td}>All accounts</td>
            <td className={td}>{total === 0 ? '0%' : '100%'}</td>
            <td className={td}>{tokens(report.totals.total_tokens)}</td>
            <td className={td}>{money(total)}</td>
            <td className={td}>{report.totals.runs}</td>
            <td className={td}>{report.totals.subagents}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

type BarRow = {
  key: string;
  label: string;
  cost: number;
  /** One plain line on what the row is. */
  text?: string;
  /** The numbers under it. */
  detail: ReactNode;
};

/** Rows of cost: name, bar, share of the total and cost, with what it is and its per-run or per-agent numbers under. */
function Bars({ rows, paint, total }: { rows: BarRow[]; paint: string; total: number }) {
  const max = Math.max(...rows.map((one) => one.cost), 0.0001);
  return (
    <ul className={`${card} m-0 list-none py-2 p-0`}>
      {rows.length === 0 && <li className="px-4 py-2 text-xs text-neutral-700">Nothing yet.</li>}
      {rows.map((one) => (
        <li key={one.key} className="px-4 py-2 text-xs">
          <div className="grid grid-cols-[minmax(0,230px)_minmax(0,1fr)_44px_72px] items-center gap-3">
            <span className="truncate font-semibold" title={one.label}>
              {one.label}
            </span>
            <span className="block h-2 overflow-hidden rounded-full bg-neutral-200" aria-hidden>
              <i className={`block h-2 rounded-full ${paint}`} style={{ width: `${(one.cost / max) * 100}%` }} />
            </span>
            <span className="text-right font-mono text-neutral-700">{share(one.cost, total)}</span>
            <span className="text-right font-mono">{money(one.cost)}</span>
          </div>
          {one.text && <div className="mt-0.5 text-[11px] text-neutral-700">{one.text}</div>}
          <div className="mt-0.5 text-[11px] text-neutral-700">{one.detail}</div>
        </li>
      ))}
    </ul>
  );
}

const share = (cost: number, total: number) => (total <= 0 ? '0%' : `${Math.round((cost / total) * 100)}%`);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** `Fri 6, 14:30`, local. */
const when = (iso: string) => {
  const at = new Date(iso);
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${at.getDate()}, ${clock}`;
};

type RunAgent = AccountUsageReport['runs'][number]['agents'][number];

/** The main agent first, then each subagent under the one that started it, with how deep it sits. */
function nested(agents: RunAgent[]): { agent: RunAgent; depth: number }[] {
  const subs = agents.filter((one) => one.agent_id !== null);
  const ids = new Set(subs.map((one) => one.agent_id));
  const out: { agent: RunAgent; depth: number }[] = agents
    .filter((one) => one.agent_id === null)
    .map((agent) => ({ agent, depth: 0 }));
  const place = (parent: string | null, depth: number) => {
    for (const agent of subs) {
      const under = agent.parent_id !== null && ids.has(agent.parent_id) ? agent.parent_id : null;
      if (under !== parent) continue;
      out.push({ agent, depth });
      place(agent.agent_id, depth + 1);
    }
  };
  place(null, 1);
  return out;
}

const STATUS: Record<SubagentStatus, { mark: string; word: string; tone: string }> = {
  [SubagentStatus.Working]: { mark: '●', word: 'working', tone: 'text-info' },
  [SubagentStatus.Done]: { mark: '✓', word: 'done', tone: 'text-ok' },
  [SubagentStatus.Failed]: { mark: '✕', word: 'failed', tone: 'text-accent-700' },
  [SubagentStatus.Stopped]: { mark: '■', word: 'stopped', tone: 'text-warn' },
};

function StatusMark({ status }: { status: SubagentStatus | null }) {
  if (status === null) return <span className="text-[11px] text-neutral-700">not tracked</span>;
  const one = STATUS[status];
  return (
    <span title={one.word} className={`inline-flex items-center gap-1 text-[11px] font-semibold ${one.tone}`}>
      <span aria-hidden>{one.mark}</span>
      {one.word}
    </span>
  );
}

/** How long a subagent lived: its start to its end, "working" while it goes, "not timed" when no start was kept. */
function lifetime(agent: RunAgent): string {
  if (agent.started_at === null) return 'not timed';
  if (agent.finished_at === null) return agent.status === SubagentStatus.Working ? 'working' : 'not timed';
  return duration(Date.parse(agent.finished_at) - Date.parse(agent.started_at));
}

/** The costliest runs; a row opens to its main agent and subagents. */
function TopRuns({
  report,
  oneAccount,
  accountLabel,
}: {
  report: AccountUsageReport;
  oneAccount: boolean;
  accountLabel: (id: string | null) => string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className={`${card} overflow-hidden`}>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line">
            <th className={th}>Run</th>
            <th className={th}>{oneAccount ? 'When' : 'Account'}</th>
            <th className={th}>Tokens</th>
            <th className={th}>Cost</th>
            <th className={th}>Subagents</th>
          </tr>
        </thead>
        <tbody>
          {report.runs.map((run, index) => {
            const key = `${run.session_id}:${run.finished_at}:${index}`;
            const opened = open === key;
            return (
              <Fragment key={key}>
                <tr className="border-t border-line first:border-t-0">
                  <td className={td}>
                    <button
                      type="button"
                      aria-expanded={opened}
                      aria-label={`${opened ? 'Hide' : 'Show'} agents of ${run.title}`}
                      onClick={() => setOpen(opened ? null : key)}
                      className="flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-[12.5px]"
                    >
                      <span aria-hidden className="w-3 text-neutral-700">
                        {opened ? '▾' : '▸'}
                      </span>
                      <span>{run.title}</span>
                      <span className="rounded-full bg-neutral-200 px-2 py-px text-[10px] font-semibold text-neutral-700 uppercase">
                        {workLabel(run.work)}
                      </span>
                    </button>
                  </td>
                  <td className={td}>{oneAccount ? when(run.finished_at) : accountLabel(run.account_id)}</td>
                  <td className={td}>{tokens(run.tokens)}</td>
                  <td className={td}>{money(run.cost_usd)}</td>
                  <td className={td}>{run.subagents}</td>
                </tr>
                {opened &&
                  nested(run.agents).map(({ agent, depth }) => (
                    <tr key={String(agent.agent_id)} className="bg-surface/60 text-neutral-800">
                      <td className={td} style={{ paddingLeft: `${2.5 + depth * 1.25}rem` }}>
                        <span className="inline-flex flex-wrap items-center gap-2">
                          {agent.agent_id === null ? (
                            'Main agent'
                          ) : (
                            <>
                              <StatusMark status={agent.status} />
                              {`${agent.type ?? 'Subagent'} · ${agent.description ?? agent.agent_id}`}
                            </>
                          )}
                        </span>
                      </td>
                      <td className={td}>{agent.agent_id === null ? '' : lifetime(agent)}</td>
                      <td className={td}>{tokens(agent.tokens)}</td>
                      <td className={td}>{money(agent.cost_usd)}</td>
                      <td className={td} />
                    </tr>
                  ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Skeleton() {
  return (
    <div role="status" className={`${card} mt-4 flex flex-col gap-2.5 px-4 py-4`}>
      <span className="block h-3 w-3/5 animate-pulse rounded bg-neutral-200" />
      <span className="block h-3 w-11/12 animate-pulse rounded bg-neutral-200" />
      <span className="block h-3 w-3/4 animate-pulse rounded bg-neutral-200" />
      <span className="text-xs text-neutral-700">Reading usage…</span>
    </div>
  );
}

function AccountHeader({ account }: { account: ClaudeAccount }) {
  return (
    <div className={`${card} mt-4 grid grid-cols-1 items-center gap-4 px-4 py-3 md:grid-cols-2`}>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <strong className="font-mono text-[13px]">{account.label}</strong>
          {account.plan && <span className="text-xs text-neutral-700">{account.plan}</span>}
          <Pill tone={account.enabled ? 'ok' : 'off'}>{account.enabled ? 'ENABLED' : 'DISABLED'}</Pill>
        </div>
        {!account.enabled && (
          <div className="mt-1 text-xs text-neutral-700">Agents skip it. Enable it on the Accounts tab.</div>
        )}
      </div>
      {account.signed_in && (
        <div className="flex flex-col gap-1.25">
          <UsageBar
            label="5-hour"
            tip="How much of this account's 5-hour usage window is used."
            pct={account.five_hour_pct}
            resetsAt={account.five_hour_resets_at}
            accentAt={90}
          />
          <UsageBar
            label="Weekly"
            tip="How much of this account's weekly usage is used."
            pct={account.weekly_pct}
            resetsAt={account.weekly_resets_at}
            accentAt={80}
          />
        </div>
      )}
    </div>
  );
}

/** The Usage tab: what the agents spent on each Claude account, for a range, all accounts or one. */
export function AccountUsageView({
  account,
  range,
  onChange,
  onOpenAccounts,
}: {
  account: string | null;
  range: string | null;
  onChange: (next: { account?: string | null; range?: string | null }) => void;
  onOpenAccounts: () => void;
}) {
  const accounts = useAgentAccounts();
  const hub = useCliProxy();
  const list = accounts.data?.data ?? [];
  const picked = account === 'none' || list.some((one) => one.id === account) ? account : null;
  const current = rangeOf(range);
  const usage = useAccountUsage(current, picked);
  // Which buckets exist comes from the all-accounts read, which is the same request when it is the one shown.
  const everyone = useAccountUsage(current, null);
  const hasNone = everyone.data?.accounts.some((entry) => entry.account_id === null) ?? false;
  const proxied = hub.data?.data.enabled ?? false;
  const sorted = ascending(list, (one) => one.label);
  const order = sorted.map((one) => one.id);
  const report = usage.data;
  const labelOf = (id: string | null) =>
    id === null ? 'Not attributed' : (list.find((one) => one.id === id)?.label ?? 'Removed account');
  const phrase = RANGES.find((one) => one.id === current)?.phrase ?? '';
  const one = list.find((candidate) => candidate.id === picked);

  return (
    <div>
      {allDisabled(list) && <AllDisabledBanner onOpenAccounts={onOpenAccounts} />}
      <div className="flex flex-wrap items-center gap-3">
        <fieldset aria-label="Account" className="m-0 min-w-0 border-0 p-0 flex flex-wrap gap-1.5">
          <button
            type="button"
            aria-pressed={picked === null}
            onClick={() => onChange({ account: null })}
            className={chip(picked === null)}
          >
            All accounts
          </button>
          {sorted.map((one) => (
            <button
              key={one.id}
              type="button"
              aria-pressed={picked === one.id}
              onClick={() => onChange({ account: one.id })}
              className={chip(picked === one.id)}
            >
              <Swatch paint={accountPaint(one.id, order)} />
              {one.label}
            </button>
          ))}
          {(hasNone || picked === 'none') && (
            <button
              type="button"
              aria-pressed={picked === 'none'}
              onClick={() => onChange({ account: 'none' })}
              className={chip(picked === 'none')}
            >
              <Swatch paint={HATCHED} />
              Not attributed
            </button>
          )}
        </fieldset>
        <span className="flex-1" />
        <fieldset aria-label="Range" className="m-0 border-0 flex gap-0.5 rounded-lg bg-neutral-200 p-0.75">
          {RANGES.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={current === option.id}
              onClick={() => onChange({ range: option.id === UsageRange.Week ? null : option.id })}
              className={`cursor-pointer rounded-md border-0 px-3 py-1 text-xs ${
                current === option.id ? 'bg-card font-bold text-text shadow-sm' : 'bg-transparent text-neutral-700'
              }`}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
      </div>

      {one && <AccountHeader account={one} />}
      {picked === 'none' && (
        <div className={`${card} mt-4 px-4 py-3 text-[13px]`}>
          <strong>Not attributed</strong>
          <span className="text-xs text-neutral-700"> · runs before accounts were tracked, or through CLIProxy</span>
        </div>
      )}

      {usage.isPending && <Skeleton />}
      {usage.isError && (
        <div
          role="alert"
          className="mt-4 flex items-center gap-3 rounded-lg border border-accent-300 bg-accent-100 px-4 py-2.5 text-xs text-accent-700"
        >
          <span className="flex-1">
            <strong>Could not read usage:</strong> {usage.error.message}
          </span>
          <Button className="px-3 py-1.25 text-xs" onClick={() => void usage.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {report && report.totals.runs === 0 && one && (
        <div className={`${card} mt-4 px-4 py-8 text-center`}>
          <div className="font-semibold">No runs counted for {one.label} in this range yet.</div>
          <div className="mt-1 text-xs text-neutral-700">
            Runs are counted for an account from the time this version started; earlier runs are under{' '}
            <button
              type="button"
              onClick={() => onChange({ account: 'none' })}
              className="cursor-pointer border-0 bg-transparent p-0 text-xs text-accent-700 underline"
            >
              Not attributed
            </button>
            .
          </div>
        </div>
      )}
      {report && report.totals.runs === 0 && !one && (
        <div className={`${card} mt-4 px-4 py-8 text-center`}>
          <div className="font-semibold">No agent runs {phrase}</div>
          <div className="mt-1 text-xs text-neutral-700">
            Runs show here once they end.{' '}
            {RANGES.filter((option) => option.id !== current).map((option, at) => (
              <Fragment key={option.id}>
                {at > 0 && ' · '}
                <button
                  type="button"
                  onClick={() => onChange({ range: option.id === UsageRange.Week ? null : option.id })}
                  className="cursor-pointer border-0 bg-transparent p-0 text-xs text-accent-700 underline"
                >
                  {option.label}
                </button>
              </Fragment>
            ))}
          </div>
        </div>
      )}
      {report && report.totals.runs > 0 && (
        <>
          <Figures report={report} />
          <Block title="Cost per day" sub={picked === null ? 'stacked by account' : 'stacked by work'}>
            <DayChart report={report} oneAccount={picked !== null} order={order} accountLabel={labelOf} />
          </Block>
          {picked === null && (
            <Block title="By account" sub="who spent the credit">
              <AccountTable report={report} order={order} activeId={accounts.data?.meta.active_account_id ?? null} />
            </Block>
          )}
          <Block title="By work" sub="what the agents were doing">
            <Bars
              paint="bg-neutral-800"
              total={report.work.reduce((sum, entry) => sum + entry.cost_usd, 0)}
              rows={report.work.map((entry) => ({
                key: entry.work,
                label: workLabel(entry.work),
                cost: entry.cost_usd,
                text: workText(entry.work),
                detail: `${plural(entry.runs, 'run')} · ${money(entry.runs === 0 ? 0 : entry.cost_usd / entry.runs)} per run · ${tokens(
                  entry.runs === 0 ? 0 : Math.round(entry.tokens / entry.runs),
                )} tok per run · ${(entry.runs === 0 ? 0 : entry.subagents / entry.runs).toFixed(1)} subagents per run`,
              }))}
            />
          </Block>
          <Block title="By subagent type" sub="who did the work">
            <Bars
              paint="bg-accent"
              total={report.subagent_types.reduce((sum, entry) => sum + entry.cost_usd, 0)}
              rows={report.subagent_types.map((type) => ({
                key: `${type.main}:${type.type}`,
                label: type.main ? 'Main agent' : (type.type ?? 'Type not kept (earlier runs)'),
                cost: type.cost_usd,
                text: type.main ? "The run's own work, outside any subagent" : undefined,
                detail: (
                  <>
                    {plural(type.agents, 'agent')} ·{' '}
                    <span className={type.failed > 0 ? 'font-semibold text-accent-700' : ''}>{type.failed} failed</span>
                    {type.avg_ms !== null && ` · avg ${duration(type.avg_ms)}`}
                    {` · ${money(type.agents === 0 ? 0 : type.cost_usd / type.agents)} per agent`}
                  </>
                ),
              }))}
            />
          </Block>
          <Block
            title={picked === null ? 'Top spenders' : 'Runs on this account'}
            sub={picked === null ? 'runs, most cost first · a row opens to its agents' : 'most cost first'}
          >
            <TopRuns report={report} oneAccount={picked !== null} accountLabel={labelOf} />
          </Block>
        </>
      )}
      {proxied && (
        <div
          role="status"
          className="mt-6 rounded-lg border border-line bg-surface px-4 py-2.5 text-xs text-neutral-800"
        >
          CLIProxy picks the account for new runs; the totals above are the runs this console recorded.
        </div>
      )}
    </div>
  );
}

const chip = (on: boolean) =>
  `inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
    on ? 'border-text bg-text text-card' : 'border-divider bg-card text-text hover:bg-neutral-200'
  }`;
