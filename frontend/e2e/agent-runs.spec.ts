import { mkdirSync, readFileSync } from 'node:fs';
import { expect, type Page, type Route, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = new Date().toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const REPO = {
  id: 'r1',
  name: 'apis',
  path: '/work/apis',
  host: 'github',
  remote_slug: 'example/apis',
  default_branch: 'main',
  created_at: NOW,
  branch: 'main',
  dirty: false,
  missing: false,
  session_count: 0,
};

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'repo',
  title: `task ${id}`,
  model: 'claude-sonnet-5-5',
  effort: 'high',
  access_mode: 'supervised',
  account_id: null,
  repo_id: 'r1',
  branch: `feat/${id}`,
  pr_number: null,
  connection_ids: null,
  alert_id: null,
  state: 'working',
  last_message_preview: null,
  last_error: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook: null,
  queued_message: null,
  ...extra,
});

const split = (commands: number) => [
  { phase: 'thinking', ms: 60_000 },
  { phase: 'reading', ms: 90_000 },
  { phase: 'editing', ms: 60_000 },
  { phase: 'commands', ms: commands },
  { phase: 'waiting_you', ms: 0 },
];

const run = (id: string, extra: Record<string, unknown> = {}, sessionExtra: Record<string, unknown> = {}) => ({
  session: session(id, sessionExtra),
  running: true,
  outcome: null,
  started_at: ago(12),
  finished_at: null,
  can_resume: true,
  can_retry: true,
  subagents: [],
  health: 'on_track',
  health_reason: 'On track: Running pnpm lint',
  activity: 'Running pnpm lint',
  cost_usd: null,
  tokens: null,
  usage: null,
  limit: null,
  split: split(60_000),
  ...extra,
});

const RUNS = [
  run('slow', {
    health: 'slow',
    health_reason: 'Slow: pnpm test backend running 6m 10s, usual 40s',
    split: split(480_000),
    subagents: [
      {
        id: 't1',
        parent_id: null,
        description: 'Explore the writers',
        type: 'Explore',
        status: 'working',
        started_at: ago(10),
        finished_at: null,
      },
    ],
  }),
  run(
    'need',
    { health: 'needs_you', health_reason: 'Waiting on you for 4m: "Apply the fix to prod config too?"' },
    { state: 'waiting_input' },
  ),
  run('ok'),
  run(
    'bad',
    {
      running: false,
      outcome: 'failed',
      finished_at: ago(1),
      health: 'failed',
      health_reason: 'Failed: The agent ran `pnpm install` and it failed.',
    },
    { state: 'failed' },
  ),
  run(
    'stopped',
    {
      running: false,
      outcome: 'stopped',
      finished_at: ago(2),
      health: 'stopped',
      health_reason: 'Stopped by you. Play carries on.',
    },
    { state: 'idle' },
  ),
];

const STAGES = [
  ['read_task', 'Read task'],
  ['explore', 'Explore'],
  ['edit', 'Edit'],
  ['run_tests', 'Run tests'],
  ['fix', 'Fix'],
  ['commit', 'Commit + hooks'],
  ['open_pr', 'Open PR'],
].map(([id, label], index) => ({
  id,
  label,
  state: index < 3 ? 'done' : index === 3 ? 'now' : 'todo',
  stopped: null,
}));

const step = (id: string, summary: string, phase: string, startedMinutesAgo: number, tookMinutes: number | null) => ({
  id,
  agent_id: null,
  tool: summary.startsWith('$ ') ? 'Bash' : 'Read',
  summary,
  phase,
  started_at: ago(startedMinutesAgo),
  finished_at: tookMinutes === null ? null : ago(startedMinutesAgo - tookMinutes),
  waited_ms: 0,
  ok: tookMinutes === null ? null : true,
  error: null,
});

const detailOf = (id: string, extra: Record<string, unknown> = {}) => ({
  run: RUNS.find((one) => one.session.id === id),
  steps: [step('a', 'Read billing/writer.ts', 'reading', 11, 1), step('b', '$ pnpm test backend', 'commands', 8, null)],
  stages: STAGES,
  slow: null,
  failure: null,
  ...extra,
});

type Calls = { method: string; path: string; body: unknown }[];

/** A daemon with these runs; every control the page uses answers, and each call is kept in order. */
async function routeRuns(page: Page, runs: unknown[] = RUNS): Promise<Calls> {
  const calls: Calls = [];
  const answer = (route: Route, status: number, json?: unknown) => {
    const request = route.request();
    calls.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postData() ? request.postDataJSON() : null,
    });
    return route.fulfill(json === undefined ? { status } : { status, json });
  };
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: [REPO], meta: { next_cursor: null } } }));
  await page.route('**/api/agent-runs', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { data: runs, meta: { next_cursor: null } } })
      : answer(route, 200, { data: { dismissed: 1 } }),
  );
  await page.route('**/api/agent-runs/usage', (route) =>
    route.fulfill({ json: { data: { cost_usd: 0.31, tokens: 48_000, runs: 4 } } }),
  );
  await page.route('**/api/agent-runs/stop-all', (route) => answer(route, 200, { data: { stopped: 3 } }));
  await page.route('**/api/agent-runs/slow', (route) =>
    route.fulfill({
      json: {
        data: detailOf('slow', {
          slow: {
            right_now: 'pnpm test backend has run 6m 10s. It usually takes 40s.',
            likely_cause: 'The command reaches the network.',
            also: 'A message is queued behind this run. It sends when the run ends.',
            suggestion: 'Stop the run and tell the agent to mock the call, or allow the host.',
            blocked_host: 'api.example.com',
          },
        }),
      },
    }),
  );
  await page.route('**/api/agent-runs/bad', (route) =>
    route.fulfill({
      json: {
        data: detailOf('bad', {
          failure: {
            kind: 'network_blocked',
            what_happened: 'The agent ran `pnpm install` and it failed.',
            likely_cause:
              'The Run sandbox lets a command reach listed hosts only. registry.example.com is probably not on the list.',
            what_to_do: 'Allow registry.example.com in the Network allowlist, then Retry.',
            raw: 'ERR_PNPM_FETCH_403 GET https://registry.example.com/left-pad: Forbidden',
            blocked_host: 'registry.example.com',
            resets_at: null,
            resume_point: null,
          },
        }),
      },
    }),
  );
  await page.route(/\/api\/agent-runs\/(ok|need|stopped)$/, (route) =>
    route.fulfill({ json: { data: detailOf(route.request().url().split('/').pop() ?? 'ok') } }),
  );
  await page.route(/\/api\/agent-runs\/[^/]+$/, (route) => {
    if (route.request().method() === 'DELETE') return answer(route, 204);
    return route.fallback();
  });
  await page.route(/\/api\/sessions\/[^/]+\/(pause|stop)$/, (route) => answer(route, 204));
  await page.route(/\/api\/sessions\/[^/]+\/resume$/, (route) => answer(route, 202, { data: { message_id: 'm1' } }));
  await page.route(/\/api\/sessions\/[^/]+\/queue$/, (route) =>
    route.request().method() === 'PUT' ? answer(route, 200, { data: { queued: true } }) : answer(route, 204),
  );
  await page.route(/\/api\/sessions\/[^/]+\/queue\/send$/, (route) => answer(route, 204));
  await page.route('**/api/network-allowlist/domains', (route) =>
    answer(route, 200, { data: { domain: 'registry.example.com', builtin: false } }),
  );
  return calls;
}

const calledPaths = (calls: Calls, method: string) =>
  calls.filter((call) => call.method === method).map((call) => call.path);

test('the page says which runs to look at and why, and the sidebar counts those that need you', async ({ page }) => {
  await routeRuns(page);
  await page.goto(`${daemon.url}/agent-runs#token=${daemon.token}`);

  await expect(page.getByRole('heading', { name: 'Agent runs', level: 1 })).toBeVisible();
  const overview = page.getByRole('region', { name: 'Overview' });
  await expect(overview.getByTitle(/Going as usual/)).toContainText('1');
  await expect(overview.getByTitle(/much longer than the same step/)).toContainText('1');
  await expect(overview.getByTitle(/waits for your yes or no/)).toContainText('1');
  await expect(overview.getByTitle(/ended with an error/)).toContainText('1');
  await expect(overview).toContainText('5 runs · 48k tokens · about $0.31 today');
  await expect(overview).toContainText('1 run is slower than usual');
  await expect(overview).toContainText('1 run ended with an error');

  // Needs you first, then slow, then failed.
  const cards = page.locator('ul > li').filter({ has: page.getByRole('link', { name: /^Session · / }) });
  await expect(cards.nth(0)).toContainText('Session · task need');
  await expect(cards.nth(1)).toContainText('Session · task slow');
  await expect(cards.nth(1)).toContainText('Slow: pnpm test backend running 6m 10s, usual 40s');
  await expect(cards.nth(1)).toContainText('1 subagent (1 working)');
  await expect(cards.nth(2)).toContainText('Session · task bad');

  await expect(page.getByRole('link', { name: /Agent runs/ })).toContainText('1');

  await page.getByRole('tab', { name: /Slow/ }).click();
  await expect(cards).toHaveCount(1);
  await page.getByRole('tab', { name: /Ended/ }).click();
  await expect(cards).toHaveCount(2);

  await page.getByRole('link', { name: 'Session · task bad' }).click();
  await expect(page).toHaveURL(/\/workspace\?session=bad$/);
});

test('a slow run opens to its stage, where the time went and why, and offers a way out', async ({ page }) => {
  const calls = await routeRuns(page);
  await page.goto(`${daemon.url}/agent-runs?run=slow#token=${daemon.token}`);

  await expect(page.getByText('Why this run is slow')).toBeVisible();
  await expect(page.getByText('The command reaches the network.')).toBeVisible();
  await expect(page.locator('[aria-current="step"]')).toHaveText(/Run tests/);
  await expect(page.getByText(/^Where the .* went/)).toBeVisible();
  await expect(page.getByText(/^Commands and tools/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Timeline/ })).toBeVisible();
  await expect(page.getByTitle('Explore the writers').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Steps/ })).toBeVisible();
  await expect(page.getByText('pnpm test backend', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Stop and tell the agent to skip it' }).click();
  await expect
    .poll(() => calls.filter((call) => call.path.includes('/queue')).map((call) => `${call.method} ${call.path}`))
    .toEqual(['PUT /api/sessions/slow/queue', 'POST /api/sessions/slow/queue/send']);

  await page.getByRole('button', { name: 'Allow api.example.com' }).click();
  await expect
    .poll(() => calls.find((call) => call.path === '/api/network-allowlist/domains')?.body)
    .toEqual({ domain: 'api.example.com' });
});

test('a failed run says what happened, why and what to do, and Allow and Retry does both', async ({ page }) => {
  const calls = await routeRuns(page);
  await page.goto(`${daemon.url}/agent-runs?run=bad#token=${daemon.token}`);

  await expect(page.getByText('Why this run ended')).toBeVisible();
  await expect(page.getByText('Network blocked', { exact: true })).toBeVisible();
  await expect(page.getByText(/registry\.example\.com is probably not on the list/)).toBeVisible();
  await expect(page.getByText('ERR_PNPM_FETCH_403')).toBeVisible();

  await expect(page.getByRole('button', { name: 'Retry only' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow registry.example.com and Retry' }).click();
  await expect
    .poll(() => calledPaths(calls, 'POST'))
    .toEqual(['/api/network-allowlist/domains', '/api/sessions/bad/resume']);
});

test('each run pauses, stops, plays, retries and dismisses, and Stop all asks first', async ({ page }) => {
  const calls = await routeRuns(page);
  await page.goto(`${daemon.url}/agent-runs#token=${daemon.token}`);

  const card = (title: string) =>
    page.locator('ul > li').filter({ has: page.getByRole('link', { name: title, exact: true }) });
  await card('Session · task ok')
    .getByRole('button', { name: /^Pause/ })
    .click();
  await card('Session · task ok').getByRole('button', { name: 'Stop the run where it is' }).click();
  await card('Session · task stopped').getByRole('button', { name: /^Play/ }).click();
  await card('Session · task bad')
    .getByRole('button', { name: /^Retry/ })
    .click();
  await card('Session · task bad')
    .getByRole('button', { name: /^Dismiss/ })
    .click();
  await expect
    .poll(() => calls.map((call) => `${call.method} ${call.path}`))
    .toEqual([
      'POST /api/sessions/ok/pause',
      'POST /api/sessions/ok/stop',
      'POST /api/sessions/stopped/resume',
      'POST /api/sessions/bad/resume',
      'DELETE /api/agent-runs/bad',
    ]);

  await page.getByRole('button', { name: 'Stop all' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Stop 3 runs?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(calls.some((call) => call.path.endsWith('/stop-all'))).toBe(false);
  await page.getByRole('button', { name: 'Stop all' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop all' }).click();
  await expect.poll(() => calls.some((call) => call.path.endsWith('/stop-all'))).toBe(true);

  await page.getByRole('button', { name: 'Dismiss ended' }).click();
  await expect.poll(() => calls.some((call) => call.method === 'DELETE' && call.path === '/api/agent-runs')).toBe(true);
});

test('with nothing running the page says so, and the tray links to it', async ({ page }) => {
  await routeRuns(page, []);
  await page.goto(`${daemon.url}/repos#token=${daemon.token}`);
  await page.getByRole('button', { name: 'Running agents' }).click();
  await page.getByRole('link', { name: 'Open Agent runs →' }).click();
  await expect(page).toHaveURL(/\/agent-runs$/);
  await expect(page.getByText(/^No agent runs\./)).toBeVisible();
});

test('the tray lists three going runs, Show all and Show less fold the rest, and an opened run shows why it is slow', async ({
  page,
}) => {
  await routeRuns(page, [...RUNS, run('ok2'), run('ok3'), run('ok4')]);
  await page.goto(`${daemon.url}/repos#token=${daemon.token}`);
  await page.getByRole('button', { name: 'Running agents' }).click();
  const tray = page.getByRole('dialog', { name: 'Agent runs' });
  const going = tray.getByRole('link', { name: /^Session · task (slow|ok\d?)$/ });

  await expect(going).toHaveCount(3);
  await tray.getByRole('button', { name: 'Show all' }).click();
  await expect(going).toHaveCount(5);
  await tray.getByRole('button', { name: 'Show less' }).click();
  await expect(going).toHaveCount(3);

  // The header stays inside the window however many runs there are.
  const top = await tray.evaluate((node) => node.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(0);

  await tray.getByRole('button', { name: 'Show details of task slow' }).click();
  await expect(tray.getByText('Why this run is slow')).toBeVisible();
  await expect(tray.getByText('The command reaches the network.')).toBeVisible();
  await expect(tray.getByRole('heading', { name: /^Timeline/ })).toBeVisible();
});

// ---- A Session that ended on a usage limit after fanning out to 12 subagents, with a long quiet stretch. ----

const T0 = Date.now() - 25 * 60_000;
/** Minutes after the run began, as an ISO time; every instant here is a whole number of seconds. */
const at = (minutes: number) => new Date(T0 + Math.round(minutes * 60_000)).toISOString();

const FINDINGS = [
  'fraud prevention A',
  'fraud prevention B',
  'cart check',
  'collection page',
  'HTML injection',
  'XSS short',
  'XSS long description',
  'XSS keyword',
  'product search',
  'general search',
  'highlight',
  'FB DM template',
];
const FAILED = new Set([2, 12]);

const findings = FINDINGS.map((name, index) => {
  const n = index + 1;
  const started = 1.2 + 0.2 * n;
  return {
    id: `f${n}`,
    // Finding 6 runs under 5, and 8 under 7.
    parent_id: n === 6 ? 'f5' : n === 8 ? 'f7' : null,
    description: `Finding ${n} ${name}`,
    type: 'general-purpose',
    status: FAILED.has(n) ? 'failed' : 'done',
    started_at: at(started),
    finished_at: at(started + 4),
  };
});

const lanestep = (
  id: string,
  agent: string | null,
  tool: string,
  summary: string,
  phase: string,
  from: number,
  to: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  agent_id: agent,
  tool,
  summary,
  phase,
  started_at: at(from),
  finished_at: at(to),
  waited_ms: 0,
  ok: true,
  error: null,
  ...extra,
});

const LIMIT_STEPS = [
  lanestep('m1', null, 'Read', 'Read src/orders/service.ts', 'reading', 0, 0.2),
  lanestep('m2', null, 'Read', 'Read src/orders/writer.ts', 'reading', 0.3, 0.5),
  lanestep('m3', null, 'Read', 'Read src/billing/schema.ts', 'reading', 0.6, 0.8),
  lanestep('mt', null, 'Task', 'Task Fan out the findings', 'commands', 1, 9),
  lanestep('mc', null, 'Bash', '$ pnpm test backend', 'commands', 12, 12.5),
  ...findings.flatMap((one, index) => {
    const n = index + 1;
    const start = 1.2 + 0.2 * n;
    const bad = FAILED.has(n);
    return [
      lanestep(`f${n}a`, one.id, 'Read', `Read src/finding${n}/index.ts`, 'reading', start + 0.2, start + 0.8),
      lanestep(`f${n}b`, one.id, 'Grep', `Grep finding${n}`, 'reading', start + 1, start + 1.6),
      lanestep(
        `f${n}c`,
        one.id,
        'Bash',
        `$ rg -n "finding${n}" src; git diff --name-only origin/main...HEAD; cat src/finding${n}/index.ts`,
        'commands',
        start + 2,
        start + 3,
        bad ? { ok: false, error: n === 2 ? 'could not read the base branch' : 'rate_limit_error' } : {},
      ),
    ];
  }),
];

const tok = (input: number, output: number, cache_read: number, cache_write: number) => ({
  input,
  output,
  cache_read,
  cache_write,
});
const MAIN_TOKENS = tok(30_000, 10_000, 200_000, 44_000);
const SUB_TOKENS = tok(7_500, 2_500, 58_000, 8_000);
const ALL_TOKENS = tok(30_000 + 12 * 7_500, 10_000 + 12 * 2_500, 200_000 + 12 * 58_000, 44_000 + 12 * 8_000);
const sumTokens = (t: ReturnType<typeof tok>) => t.input + t.output + t.cache_read + t.cache_write;
/** The fixture's own cost: $0.24 for the main agent and $0.05 for each subagent. */
const COST = { main: 0.24, each: 0.05, all: 0.84 };

const RESETS = new Date(Date.now() + (2 * 60 + 38) * 60_000).toISOString();

const limitRun = run(
  'limit',
  {
    running: false,
    outcome: 'rate_limited',
    started_at: at(0),
    finished_at: at(14),
    health: 'failed',
    health_reason: 'Failed: The Claude account hit its usage limit.',
    activity: null,
    subagents: findings,
    cost_usd: COST.all,
    tokens: sumTokens(ALL_TOKENS),
    usage: {
      total: { tokens: ALL_TOKENS, cost_usd: COST.all },
      main: { tokens: MAIN_TOKENS, cost_usd: COST.main },
      subagents: {
        tokens: tok(12 * 7_500, 12 * 2_500, 12 * 58_000, 12 * 8_000),
        cost_usd: COST.all - COST.main,
      },
      by_agent: [
        { agent_id: null, tokens: MAIN_TOKENS, cost_usd: COST.main },
        ...findings.map((one) => ({ agent_id: one.id, tokens: SUB_TOKENS, cost_usd: COST.each })),
      ],
      reported_cost_usd: 58.7,
      models: ['claude-sonnet-5-5'],
    },
    limit: { since: at(13), resets_at: RESETS },
    split: [],
  },
  { account_id: 'acc1', state: 'failed', title: 'security findings' },
);

const LIMIT_STAGES = [
  ['read_task', 'Read task', 'done', null],
  ['explore', 'Explore', 'done', null],
  ['analyze', 'Analyze', 'now', { tone: 'limit', label: 'Stopped here: usage limit' }],
  ['report', 'Report', 'todo', null],
].map(([id, label, state, stopped]) => ({ id, label, state, stopped }));

const LIMIT_DETAIL = {
  run: limitRun,
  steps: LIMIT_STEPS,
  stages: LIMIT_STAGES,
  slow: null,
  failure: {
    kind: 'rate_limited',
    what_happened: 'The Claude account hit its usage limit.',
    likely_cause: 'The account used up its usage window. Longer runs and larger models use it fastest.',
    what_to_do: 'Switch to another account in Agents & accounts, or Retry after the limit resets.',
    raw: 'rate_limit_error: usage limit reached for this account',
    blocked_host: null,
    resets_at: RESETS,
    resume_point: 'Finding 12 (11 of 12 subagents finished)',
  },
};

const ACCOUNT = (id: string, email: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: email,
  position: 0,
  signed_in: true,
  signing_in: false,
  email,
  plan: 'max',
  five_hour_pct: 100,
  five_hour_resets_at: null,
  weekly_pct: 40,
  weekly_resets_at: null,
  usage_seen_at: null,
  last_checked_at: null,
  created_at: NOW,
  is_active: false,
  sign_in_link: null,
  ...extra,
});

async function routeLimitRun(page: Page) {
  await routeRuns(page, [limitRun]);
  await page.route('**/api/agent-runs/limit', (route) => route.fulfill({ json: { data: LIMIT_DETAIL } }));
  await page.route('**/api/agent-accounts', (route) =>
    route.fulfill({
      json: {
        data: [
          ACCOUNT('acc1', 'dev@example.com', { is_active: true }),
          ACCOUNT('acc2', 'other@example.com', { five_hour_pct: 5 }),
        ],
        meta: { next_cursor: null, active_account_id: 'acc1', smart_pick: null },
      },
    }),
  );
}

const seconds = (text: string) => {
  const hours = /(\d+)h/.exec(text);
  const minutes = /(\d+)m/.exec(text);
  const secs = /(\d+)s/.exec(text);
  return Number(hours?.[1] ?? 0) * 3600 + Number(minutes?.[1] ?? 0) * 60 + Number(secs?.[1] ?? 0);
};

for (const size of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
]) {
  test(`a run that ended on a usage limit with 12 subagents reads whole at ${size.width}px`, async ({ page }) => {
    await page.setViewportSize(size);
    await routeLimitRun(page);
    await page.goto(`${daemon.url}/agent-runs?run=limit#token=${daemon.token}`);
    const card = page
      .locator('ul > li')
      .filter({ has: page.getByRole('link', { name: 'Session · security findings' }) });

    // The phases are the run's own, the one it stopped in says why.
    await expect(page.getByText('Stopped here: usage limit')).toBeVisible();
    await expect(page.locator('[aria-current="step"]')).toHaveText(/Analyze/);

    // Nothing in the facts is cut short, and the usage reads as the fixture's own counts and prices.
    const facts = page.getByTestId('run-facts');
    await expect(facts).toContainText('dev@example.com');
    await expect(facts).toContainText('Session');
    const usage = facts
      .locator('div')
      .filter({ hasText: /^Usage/ })
      .locator('dd');
    await expect(usage).toHaveText(`1.2M tok · $${COST.all.toFixed(2)}`);
    await expect(usage).toHaveAttribute(
      'title',
      /input 120,000 · output 40,000 · cache read 896,000 · cache write 140,000/,
    );
    await expect(usage).toHaveAttribute('title', /The SDK reported \$58\.70/);
    for (const dd of await facts.locator('dd').all()) {
      const [scroll, client] = await dd.evaluate((node) => [node.scrollWidth, node.clientWidth]);
      expect(scroll, (await dd.textContent()) ?? '').toBeLessThanOrEqual(client + 1);
    }

    // The breakdown adds up to the run's time, which is the header's.
    const heading = page.getByRole('heading', { name: /^Where the .* went/ });
    await expect(heading).toContainText('waiting on 12 subagents');
    const total = seconds(((await heading.textContent()) ?? '').replace(/^Where the /, '').replace(/ went.*/s, ''));
    const header = (await card.locator('time').first().textContent()) ?? '';
    expect(total).toBe(seconds(header));
    expect(total).toBe(14 * 60);
    const legend = page.getByTestId('legend');
    const parts = await legend.locator('li').evaluateAll((nodes) =>
      nodes.map((node) => {
        const value = node.querySelector('span:last-child')?.textContent ?? '';
        return [(node.textContent ?? '').replace(value, '').trim(), value];
      }),
    );
    expect(parts.map(([name]) => name)).toEqual([
      'Thinking',
      'Reading',
      'Editing',
      'Commands and tools',
      'Subagents',
      'Waiting on you',
      'Waiting on limit',
    ]);
    expect(parts.reduce((sum, [, value]) => sum + seconds(value as string), 0)).toBe(total);
    expect(Object.fromEntries(parts as [string, string][])['Waiting on limit']).toBe('1m 00s');

    // Subagent table: longest first, a click lists only that subagent's steps.
    const table = page.getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(1 + 8);
    await table.getByRole('button', { name: /Finding 2 / }).click();
    await expect(page.getByRole('button', { name: /^Only Finding 2/ })).toBeVisible();
    await expect(page.getByText('Finding 2 fraud prevention B (3 steps)')).toBeVisible();
    await page.getByRole('button', { name: /^Only Finding 2/ }).click();

    // The timeline draws thinking, folds the long quiet stretch, and counts its lanes.
    await expect(page.getByText('12 subagents · 10 done · 2 failed')).toBeVisible();
    await expect(page.locator('[data-lane="main"] [data-phase="thinking"]').first()).toBeVisible();
    await expect(page.locator('[data-lane="f3"] [data-phase="thinking"]').first()).toBeAttached();
    await expect(page.getByRole('button', { name: /^⋯ 3m 00s/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show 4 more' })).toBeVisible();
    await expect(page.locator('[data-lane^="f"]')).toHaveCount(8);
    await page.getByRole('button', { name: 'Show 4 more' }).click();
    await expect(page.locator('[data-lane^="f"]')).toHaveCount(12);
    await page.getByRole('tab', { name: 'Failed', exact: true }).click();
    await expect(page.locator('[data-lane^="f"]')).toHaveCount(2);
    await page.getByRole('tab', { name: 'All', exact: true }).click();

    // A failure marker names the error and jumps to its step.
    const marker = page.getByRole('button', { name: /^Finding 2 fraud prevention B failed/ });
    await expect(marker).toHaveAttribute('title', /could not read the base branch/);
    await marker.click();
    await expect(page.locator('#step-f2c')).toBeVisible();
    await expect(page.locator('#step-f2c')).toContainText('could not read the base branch');

    // The ended panel names the account, the reset and where a retry resumes.
    await expect(page.getByText('dev@example.com used up its usage window.')).toBeVisible();
    await expect(page.getByText(/^Resets at .* \(in 2h 3\dm/)).toBeVisible();
    await expect(page.getByText('Finding 12 (11 of 12 subagents finished)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Switch account and Retry' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Retry after reset' })).toBeDisabled();

    // The run header stays in view while the detail scrolls.
    const head = card.locator('> div').first();
    await page.getByRole('heading', { name: /^Steps/ }).scrollIntoViewIfNeeded();
    await expect(head).toBeInViewport();

    mkdirSync('/tmp/ops-console-shots', { recursive: true });
    // A window tall enough for the whole card, so the sticky header does not cover the rest in the picture.
    await page.setViewportSize({ width: size.width, height: 3400 });
    await page.screenshot({ path: `/tmp/ops-console-shots/limit-${size.width}.png` });
  });
}
