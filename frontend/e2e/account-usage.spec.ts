import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-06T10:00:00.000Z';

const account = (id: string, email: string, change: Record<string, unknown> = {}) => ({
  id,
  label: email,
  position: 1,
  signed_in: true,
  signing_in: false,
  enabled: true,
  email,
  plan: 'pro',
  five_hour_pct: 38,
  five_hour_resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  weekly_pct: 56,
  weekly_resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString(),
  usage_seen_at: NOW,
  last_checked_at: NOW,
  created_at: NOW,
  is_active: false,
  sign_in_link: null,
  ...change,
});

const ACCOUNTS = [
  account('a1', 'ops@example.com', { is_active: true }),
  account('a2', 'sam@example.com'),
  account('a3', 'dev@example.com', { enabled: false, weekly_pct: 98 }),
];

const tokenCounts = { input: 6_100_000, output: 1_400_000, cache_read: 24_000_000, cache_write: 1_200_000 };
const day = (date: string, cost: number, byAccount: [string | null, number][], byWork: [string, number][]) => ({
  date,
  cost_usd: cost,
  tokens: Math.round(cost * 60_000),
  runs: cost > 0 ? 4 : 0,
  by_account: byAccount.map(([account_id, cost_usd]) => ({ account_id, cost_usd })),
  by_work: byWork.map(([work, cost_usd]) => ({ work, cost_usd })),
});

const agent = (id: string | null, change: Record<string, unknown> = {}) => ({
  agent_id: id,
  parent_id: null,
  type: null,
  description: null,
  status: null,
  started_at: id === null ? null : '2026-11-06T08:40:00.000Z',
  finished_at: null,
  tokens: 0,
  cost_usd: 0,
  ...change,
});

const REPORT = {
  range: '7d',
  account_id: null,
  from: '2026-10-31',
  to: '2026-11-06',
  totals: { tokens: tokenCounts, total_tokens: 32_700_000, cost_usd: 536.45, runs: 78, subagents: 153 },
  days: [
    day(
      '2026-10-31',
      48,
      [
        ['a1', 30],
        ['a2', 12],
        [null, 6],
      ],
      [['chat', 48]],
    ),
    day(
      '2026-11-01',
      92,
      [
        ['a1', 50],
        ['a2', 30],
        [null, 12],
      ],
      [
        ['chat', 60],
        ['agent_review', 32],
      ],
    ),
    day(
      '2026-11-02',
      61,
      [
        ['a1', 43],
        ['a3', 18],
      ],
      [['chat', 61]],
    ),
    day(
      '2026-11-03',
      30,
      [
        ['a1', 16],
        ['a2', 14],
      ],
      [['chat', 30]],
    ),
    day(
      '2026-11-04',
      22,
      [
        ['a1', 18],
        [null, 4],
      ],
      [['agent_review', 22]],
    ),
    day(
      '2026-11-05',
      134,
      [
        ['a1', 74],
        ['a2', 34],
        ['a3', 16],
        [null, 10],
      ],
      [
        ['chat', 100],
        ['fix', 34],
      ],
    ),
    day(
      '2026-11-06',
      149,
      [
        ['a1', 92],
        ['a2', 45],
        [null, 12],
      ],
      [['chat', 149]],
    ),
  ],
  accounts: [
    {
      account_id: 'a1',
      label: 'ops@example.com',
      removed: false,
      enabled: true,
      tokens: 18_400_000,
      cost_usd: 312.4,
      runs: 41,
      subagents: 96,
    },
    {
      account_id: 'a2',
      label: 'sam@example.com',
      removed: false,
      enabled: true,
      tokens: 9_100_000,
      cost_usd: 148.75,
      runs: 22,
      subagents: 37,
    },
    {
      account_id: 'a3',
      label: 'dev@example.com',
      removed: false,
      enabled: false,
      tokens: 2_200_000,
      cost_usd: 31.1,
      runs: 6,
      subagents: 8,
    },
    {
      account_id: null,
      label: 'Not attributed',
      removed: false,
      enabled: true,
      tokens: 3_000_000,
      cost_usd: 44.2,
      runs: 9,
      subagents: 12,
    },
  ],
  work: [
    { work: 'chat', tokens: 20_000_000, cost_usd: 380.1, runs: 50, subagents: 100 },
    { work: 'agent_review', tokens: 9_000_000, cost_usd: 101.3, runs: 20, subagents: 40 },
    { work: 'kind:repo', tokens: 3_700_000, cost_usd: 55.05, runs: 8, subagents: 13 },
  ],
  subagent_types: [
    { type: null, main: true, tokens: 20_000_000, cost_usd: 364.25, agents: 78, failed: 0, avg_ms: null },
    { type: 'Explore', main: false, tokens: 6_000_000, cost_usd: 88.4, agents: 90, failed: 3, avg_ms: 42_000 },
    { type: null, main: false, tokens: 2_000_000, cost_usd: 20.1, agents: 11, failed: 0, avg_ms: null },
  ],
  runs: [
    {
      session_id: 's1',
      title: 'Fix empty-cart crash',
      kind: 'repo',
      work: 'chat',
      account_id: 'a1',
      finished_at: '2026-11-06T09:00:00.000Z',
      tokens: 2_900_000,
      cost_usd: 41.8,
      subagents: 2,
      agents: [
        agent(null, { tokens: 1_200_000, cost_usd: 18.1 }),
        agent('t1', {
          type: 'Explore',
          description: 'Find cart reducers',
          status: 'done',
          finished_at: '2026-11-06T08:42:00.000Z',
          tokens: 900_000,
          cost_usd: 9.4,
        }),
        agent('t2', {
          parent_id: 't1',
          type: 'general-purpose',
          description: 'Read the tests',
          status: 'failed',
          finished_at: '2026-11-06T08:41:30.000Z',
          tokens: 800_000,
          cost_usd: 14.3,
        }),
        agent('t3', { description: 'Old subagent', tokens: 10, cost_usd: 0.01 }),
      ],
    },
    {
      session_id: 's2',
      title: 'Review PR 412',
      kind: 'pr_review',
      work: 'agent_review',
      account_id: null,
      finished_at: '2026-11-05T09:00:00.000Z',
      tokens: 1_900_000,
      cost_usd: 29.9,
      subagents: 0,
      agents: [agent(null, { tokens: 1_900_000, cost_usd: 29.9 })],
    },
  ],
};

const ONE = {
  ...REPORT,
  account_id: 'a3',
  totals: {
    tokens: { input: 400_000, output: 90_000, cache_read: 1_600_000, cache_write: 110_000 },
    total_tokens: 2_200_000,
    cost_usd: 31.1,
    runs: 6,
    subagents: 8,
  },
  days: REPORT.days.map((one, index) =>
    index === 2
      ? day(
          one.date,
          31.1,
          [['a3', 31.1]],
          [
            ['chat', 18.4],
            ['agent_review', 12.7],
          ],
        )
      : day(one.date, 0, [], []),
  ),
  accounts: [REPORT.accounts[2]],
  work: [
    { work: 'chat', tokens: 1_400_000, cost_usd: 18.4, runs: 4, subagents: 6 },
    { work: 'agent_review', tokens: 800_000, cost_usd: 12.7, runs: 2, subagents: 2 },
  ],
  runs: [{ ...REPORT.runs[0], account_id: 'a3' }],
};

const EMPTY = {
  ...REPORT,
  totals: {
    ...REPORT.totals,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    total_tokens: 0,
    cost_usd: 0,
    runs: 0,
    subagents: 0,
  },
  days: REPORT.days.map((one) => day(one.date, 0, [], [])),
  work: [],
  subagent_types: [],
  runs: [],
};

/** The lists the page reads, and every usage request it makes. */
async function mock(page: Page, answer: (url: URL) => { status?: number; json: unknown }, list = ACCOUNTS) {
  const asked: string[] = [];
  await page.route('**/api/cliproxy**', (route) =>
    route.fulfill({
      json: {
        data: {
          enabled: false,
          address: 'http://127.0.0.1:8317',
          has_key: false,
          status: 'no_key',
          status_detail: null,
          checked_at: null,
        },
      },
    }),
  );
  await page.route('**/api/agent-accounts', (route) =>
    route.fulfill({
      json: { data: list, meta: { next_cursor: null, active_account_id: 'a1', smart_pick: null } },
    }),
  );
  await page.route('**/api/agent-accounts/usage**', (route) => {
    const url = new URL(route.request().url());
    asked.push(`${url.searchParams.get('range')}|${url.searchParams.get('account')}`);
    return route.fulfill(answer(url));
  });
  return asked;
}

const open = (page: Page, query = '') => page.goto(`${daemon.url}/agents?tab=usage${query}#token=${daemon.token}`);

test('Usage shows all accounts: the figures, the daily cost, each account, the kinds and the costliest runs', async ({
  page,
}) => {
  await mock(page, () => ({ json: { data: REPORT } }));
  await open(page);

  const figures = (title: string) => page.getByRole('region', { name: title, exact: true });
  await expect(figures('Tokens')).toContainText('32.7M');
  await expect(figures('Tokens')).toContainText('in 6.1M · out 1.4M · cache 25.2M');
  await expect(figures('Estimated cost')).toContainText('$536');
  await expect(figures('Estimated cost')).toContainText('at API prices, not billed');
  await expect(figures('Agent runs')).toContainText('78');
  await expect(figures('Subagents')).toContainText('153');
  await expect(figures('Subagents')).toContainText('2.0 per run');

  await expect(page.getByRole('img', { name: 'Cost per day' })).toContainText('Fri 6 · today');
  const table = page.getByRole('region', { name: 'By account' }).getByRole('table');
  await expect(table.getByRole('row', { name: /ops@example.com ACTIVE/ })).toContainText('$312');
  await expect(table.getByRole('row', { name: /dev@example.com DISABLED/ })).toContainText('$31.10');
  await expect(table.getByRole('row', { name: /Not attributed/ })).toContainText('runs before accounts were tracked');
  await expect(table.getByRole('row', { name: /All accounts/ })).toContainText('$536');

  const work = page.getByRole('region', { name: 'By work' });
  await expect(work).toContainText('Your messages (chat)');
  await expect(work).toContainText('Messages you send an agent in a Session');
  await expect(work).toContainText('71%');
  await expect(work).toContainText('50 runs · $7.60 per run · 400k tok per run · 2.0 subagents per run');
  await expect(work).toContainText('Agent Review');
  await expect(work).toContainText('Repo session (earlier runs)');
  const types = page.getByRole('region', { name: 'By subagent type' });
  await expect(types).toContainText('Main agent');
  await expect(types).toContainText("The run's own work, outside any subagent");
  await expect(types).not.toContainText('Main agents only');
  await expect(types).toContainText('Explore');
  await expect(types).toContainText('Type not kept (earlier runs)');
  await expect(types.getByText('3 failed')).toHaveClass(/text-accent-700/);
  await expect(types).toContainText('90 agents · 3 failed · avg 42s · $0.98 per agent');
  await expect(types).toContainText('78 agents · 0 failed · $4.67 per agent');
  await expect(types.getByText('0 failed').first()).not.toHaveClass(/text-accent-700/);

  const top = page.getByRole('region', { name: 'Top spenders' });
  await expect(top).toContainText('Review PR 412');
  await expect(top.getByRole('row', { name: /Fix empty-cart crash/ })).toContainText('Your messages (chat)');
  await expect(top.getByRole('row', { name: /Review PR 412/ })).toContainText('Agent Review');
  await expect(top).toContainText('Not attributed');
  await expect(top.getByText('Find cart reducers')).toHaveCount(0);
  await top.getByRole('button', { name: 'Show agents of Fix empty-cart crash' }).click();
  await expect(top.getByText('Main agent', { exact: true })).toBeVisible();
  await expect(top.getByText('Explore · Find cart reducers')).toBeVisible();
  // Each subagent shows its state and how long it lived; a nested one sits deeper than its parent.
  const parent = top.getByRole('row', { name: /Explore · Find cart reducers/ });
  const child = top.getByRole('row', { name: /general-purpose · Read the tests/ });
  await expect(parent).toContainText('done');
  await expect(parent).toContainText('2m 00s');
  await expect(child).toContainText('failed');
  await expect(child).toContainText('1m 30s');
  await expect(top.getByRole('row', { name: /Old subagent/ })).toContainText('not timed');
  const indent = (row: typeof parent) =>
    row
      .locator('td')
      .first()
      .evaluate((cell) => Number.parseFloat(getComputedStyle(cell).paddingLeft));
  expect(await indent(child)).toBeGreaterThan(await indent(parent));
  await expect(top.getByRole('row', { name: /^Main agent/ })).not.toContainText('done');
});

test('one account shows its own bars, its state, a trend by work and its runs', async ({ page }) => {
  const asked = await mock(page, (url) => ({
    json: { data: url.searchParams.get('account') === 'a3' ? ONE : REPORT },
  }));
  await open(page);

  await page.getByRole('button', { name: 'dev@example.com' }).click();
  await expect(page).toHaveURL(/account=a3/);
  await expect.poll(() => asked.at(-1)).toBe('7d|a3');
  await expect(page.getByText('Agents skip it. Enable it on the Accounts tab.')).toBeVisible();
  await expect(page.getByText('DISABLED').first()).toBeVisible();
  await expect(page.getByText('Weekly', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Cost per day').locator('..')).toContainText('stacked by work');
  await expect(page.getByRole('region', { name: 'By account' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Runs on this account' })).toContainText('Fix empty-cart crash');
  await expect(page.getByRole('button', { name: 'dev@example.com' })).toHaveAttribute('aria-pressed', 'true');
});

test('a range asks again, and the address keeps it', async ({ page }) => {
  const asked = await mock(page, () => ({ json: { data: REPORT } }));
  await open(page);
  await expect.poll(() => asked).toEqual(['7d|null']);

  await page.getByRole('button', { name: '30 days' }).click();
  await expect(page).toHaveURL(/range=30d/);
  await expect.poll(() => asked.at(-1)).toBe('30d|null');
  await page.getByRole('button', { name: 'Today' }).click();
  await expect.poll(() => asked.at(-1)).toBe('today|null');
  await page.getByRole('button', { name: '7 days' }).click();
  await expect(page).not.toHaveURL(/range=/);
});

test('an empty range says so and links the other ranges', async ({ page }) => {
  const asked = await mock(page, () => ({ json: { data: EMPTY } }));
  await open(page);

  await expect(page.getByText('No agent runs in the last 7 days')).toBeVisible();
  await expect(page.getByText('Estimated cost')).toHaveCount(0);
  await page.getByText('Runs show here once they end.').getByRole('button', { name: '90 days' }).click();
  await expect.poll(() => asked.at(-1)).toBe('90d|null');
  await expect(page.getByText('No agent runs in the last 90 days')).toBeVisible();
});

test('a failed read shows the error and Try again reads it again', async ({ page }) => {
  let fail = true;
  await mock(page, () =>
    fail
      ? { status: 500, json: { error: { code: 'internal', message: 'the daemon did not answer' } } }
      : { json: { data: REPORT } },
  );
  await open(page);

  await expect(page.getByRole('alert')).toContainText('Could not read usage:');
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Estimated cost')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('with every account disabled both tabs say so, and Open Accounts goes back to the list', async ({ page }) => {
  const off = ACCOUNTS.map((one) => ({ ...one, enabled: false, is_active: false }));
  await mock(page, () => ({ json: { data: REPORT } }), off);
  await open(page);

  const banner = page.getByRole('alert').filter({ hasText: 'Every Claude account is disabled.' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Open Accounts' }).click();
  await expect(page).not.toHaveURL(/tab=usage/);
  await expect(page.getByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('alert').filter({ hasText: 'Every Claude account is disabled.' })).toBeVisible();
});

test('the tabs switch between Accounts and Usage', async ({ page }) => {
  await mock(page, () => ({ json: { data: REPORT } }));
  await page.goto(`${daemon.url}/agents#token=${daemon.token}`);
  await expect(page.getByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Usage' }).click();
  await expect(page).toHaveURL(/tab=usage/);
  await expect(page.getByText('Estimated cost')).toBeVisible();
  await page.getByRole('tab', { name: 'Accounts' }).click();
  await expect(page.getByRole('list', { name: 'Claude Code accounts' })).toBeVisible();
});

for (const width of [1440, 1024]) {
  test(`the Accounts and Usage tabs read whole at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 2600 });
    await mock(page, (url) => ({ json: { data: url.searchParams.get('account') === 'a3' ? ONE : REPORT } }));
    await page.goto(`${daemon.url}/agents#token=${daemon.token}`);
    await expect(page.getByRole('list', { name: 'Claude Code accounts' })).toBeVisible();
    await page.screenshot({ path: `/tmp/account-usage-accounts-${width}.png`, fullPage: true });
    await open(page);
    await expect(page.getByText('Estimated cost')).toBeVisible();
    await page.getByRole('button', { name: 'Show agents of Fix empty-cart crash' }).click();
    await page.screenshot({ path: `/tmp/account-usage-all-${width}.png`, fullPage: true });
    await open(page, '&account=a3');
    await expect(page.getByText('Agents skip it. Enable it on the Accounts tab.')).toBeVisible();
    await page.screenshot({ path: `/tmp/account-usage-one-${width}.png`, fullPage: true });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
}

test('an old range=all address falls back to 7 days', async ({ page }) => {
  const asked = await mock(page, () => ({ json: { data: REPORT } }));
  await open(page, '&range=all');
  await expect.poll(() => asked).toEqual(['7d|null']);
  await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'false');
});

test('Not attributed has its own chip when the all-accounts read has that bucket, and picking it shows it', async ({
  page,
}) => {
  const NONE = { ...REPORT, account_id: null, accounts: [REPORT.accounts[3]], totals: { ...REPORT.totals, runs: 9 } };
  const asked = await mock(page, (url) => ({
    json: { data: url.searchParams.get('account') === 'none' ? NONE : REPORT },
  }));
  await open(page);

  const chip = page.getByRole('button', { name: 'Not attributed' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page).toHaveURL(/account=none/);
  await expect.poll(() => asked.at(-1)).toBe('7d|none');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('runs before accounts were tracked, or through CLIProxy')).toBeVisible();
});

test('no Not attributed chip when nothing is unattributed', async ({ page }) => {
  const clean = { ...REPORT, accounts: REPORT.accounts.slice(0, 3) };
  await mock(page, () => ({ json: { data: clean } }));
  await open(page);
  await expect(page.getByRole('button', { name: 'ops@example.com' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Not attributed' })).toHaveCount(0);
});

test('an account with no runs counted says so and points to Not attributed', async ({ page }) => {
  const asked = await mock(page, (url) => ({
    json: { data: url.searchParams.get('account') === 'a2' ? { ...EMPTY, account_id: 'a2' } : REPORT },
  }));
  await open(page, '&account=a2');

  await expect(page.getByText('No runs counted for sam@example.com in this range yet.')).toBeVisible();
  await expect(page.getByText('earlier runs are under')).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Not attributed' }).last().click();
  await expect(page).toHaveURL(/account=none/);
  await expect.poll(() => asked.at(-1)).toBe('7d|none');
});
