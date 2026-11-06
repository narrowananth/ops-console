import { readFileSync } from 'node:fs';
import { expect, type Page, test, type WebSocketRoute } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

const connection = (id: string, name: string, type: string, change: Record<string, unknown> = {}) => ({
  id,
  name,
  type,
  env: 'local',
  access: 'read',
  config: {},
  status: 'ok',
  status_detail: null,
  latency_ms: 4,
  last_checked_at: ago(2),
  created_at: ago(1000),
  is_prod: false,
  secret_stored: true,
  ...change,
});

const CONNECTIONS = [
  connection('c1', 'pg-tenant', 'postgres', { status: 'auth', status_detail: 'password authentication failed' }),
  connection('c2', 'mongo-prod', 'mongodb', { status: 'fail', status_detail: 'connection timed out' }),
  connection('c3', 'redis-local', 'redis'),
];

type Point = { status: string; at: string };
const points = (...statuses: string[]): Point[] =>
  statuses.map((status, index) => ({ status, at: ago((statuses.length - index) * 5) }));

const item = (area: string, target: string, id: string, name: string, change: Record<string, unknown> = {}) => ({
  area,
  target,
  id,
  name,
  kind: 'postgres',
  is_prod: false,
  status: 'ok',
  detail: null,
  latency_ms: 12,
  last_checked_at: ago(2),
  failing_since: null,
  recovered_at: null,
  history: points('ok', 'ok', 'ok', 'ok'),
  ...change,
});

const area = (change: Record<string, unknown> = {}) => ({
  interval: '30m',
  last_checked_at: ago(2),
  next_check_at: inMinutes(13),
  checking: null,
  ...change,
});

const overview = (
  items: unknown[],
  connections: Record<string, unknown> = {},
  integrations: Record<string, unknown> = {},
) => ({
  areas: { connections: area(connections), integrations: area({ interval: '1h', ...integrations }) },
  items,
});

const FAILING = [
  item('connections', 'connection', 'c1', 'pg-tenant', {
    status: 'auth',
    detail: 'password authentication failed',
    failing_since: ago(14),
    latency_ms: null,
    history: points('ok', 'ok', 'auth', 'auth'),
  }),
  item('connections', 'connection', 'c2', 'mongo-prod', {
    kind: 'mongodb',
    status: 'fail',
    detail: 'connection timed out',
    failing_since: ago(40),
    latency_ms: null,
    history: points('ok', 'fail', 'fail', 'fail'),
  }),
  item('connections', 'connection', 'c3', 'redis-local', { kind: 'redis' }),
];

/** Answers the pages' lists and `/health-watch`; `state.overview` can change under the page, and every call is kept. */
async function mock(page: Page, first: unknown, extra: { fail?: boolean } = {}) {
  const state = { overview: first, calls: [] as string[], patches: [] as unknown[], reads: 0 };
  await page.route('**/api/connections', (route) =>
    route.fulfill({ json: { data: CONNECTIONS, meta: { next_cursor: null } } }),
  );
  await page.route('**/api/health-watch', (route) => {
    state.reads++;
    if (extra.fail) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ json: { data: state.overview } });
  });
  await page.route('**/api/health-watch/*/checks', (route) => {
    state.calls.push(new URL(route.request().url()).pathname.replace('/api', ''));
    return route.fulfill({ status: 202, json: {} });
  });
  await page.route('**/api/connections/*/checks', (route) => {
    state.calls.push(new URL(route.request().url()).pathname.replace('/api', ''));
    return route.fulfill({
      json: { data: { status: 'ok', status_detail: null, latency_ms: 5, checked_at: new Date().toISOString() } },
    });
  });
  await page.route('**/api/settings', (route) => {
    const body = {
      session_defaults: { model: 'claude-sonnet-5-5', effort: 'high', access_mode: 'supervised' },
      agent_accounts: { active_account_id: null, auto_switch: true, threshold: 95, smart_usage: true },
      health_checks: {
        connections: (state.overview as ReturnType<typeof overview>).areas.connections.interval,
        integrations: (state.overview as ReturnType<typeof overview>).areas.integrations.interval,
      },
    };
    if (route.request().method() === 'PATCH') {
      const patch = route.request().postDataJSON() as { health_checks: unknown };
      state.patches.push(patch);
      return route.fulfill({ json: { data: { ...body, ...patch } } });
    }
    return route.fulfill({ json: { data: body } });
  });
  return state;
}

const open = (page: Page, path = '/connections') => page.goto(`${daemon.url}${path}#token=${daemon.token}`);

test('the strip shows when it last checked and when it checks next, and ticks', async ({ page }) => {
  await mock(page, overview(FAILING));
  await open(page);
  const strip = page.getByRole('group', { name: 'Auto-check' });
  await expect(strip.getByText('Auto-check', { exact: true })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Check every' })).toHaveText('30 minutes');
  await expect(strip).toContainText(/Last checked 2 min ago · next in 1[23]m \d\dm?s?/);
  const before = await strip.getByRole('status').textContent();
  await expect.poll(() => strip.getByRole('status').textContent(), { timeout: 4000 }).not.toBe(before);
});

test('with Off the strip says auto-check is off, and while a run goes it counts the items done and polls', async ({
  page,
}) => {
  const state = await mock(page, overview(FAILING, { interval: 'off', next_check_at: null }));
  await open(page);
  const strip = page.getByRole('group', { name: 'Auto-check' });
  await expect(strip.getByRole('button', { name: 'Check every' })).toHaveText('Off');
  await expect(strip).toContainText('Auto-check off · Last checked 2 min ago');
  await expect(strip).not.toContainText('next in');

  state.overview = overview(FAILING, { checking: { done: 3, total: 8 } });
  await strip.getByRole('button', { name: 'Check now' }).click();
  await expect(strip).toContainText('Checking… 3 of 8 done');
  await expect(strip.getByRole('button', { name: 'Check now' })).toBeDisabled();
  const reads = state.reads;
  state.overview = overview(FAILING);
  await expect(strip).not.toContainText('Checking…', { timeout: 6000 });
  expect(state.reads).toBeGreaterThan(reads);
});

test('Check now starts the run, and an interval change saves the whole health_checks setting', async ({ page }) => {
  const state = await mock(page, overview(FAILING));
  await open(page);
  const strip = page.getByRole('group', { name: 'Auto-check' });
  await strip.getByRole('button', { name: 'Check now' }).click();
  await expect.poll(() => state.calls).toEqual(['/health-watch/connections/checks']);

  const every = strip.getByRole('button', { name: 'Check every' });
  await expect(every).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(every).toHaveAttribute('aria-expanded', 'false');
  await every.click();
  await expect(every).toHaveAttribute('aria-expanded', 'true');
  const list = page.getByRole('listbox', { name: 'Check every' });
  await expect(list.getByRole('option')).toContainText([
    '30 minutes',
    '1 hour',
    '6 hours',
    '12 hours',
    '24 hours',
    'Off',
  ]);
  await expect(list.getByRole('option', { name: '30 minutes' })).toHaveAttribute('aria-selected', 'true');
  // The current option has the keyboard; the arrows move, Enter picks, Escape closes.
  await expect(list.getByRole('option', { name: '30 minutes' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await every.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(list.getByRole('option', { name: '6 hours' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0);
  await expect(every).toBeFocused();
  await expect.poll(() => state.patches).toEqual([{ health_checks: { connections: '6h', integrations: '1h' } }]);
});

test('a check that could not run says so and offers Try again', async ({ page }) => {
  await mock(page, overview(FAILING));
  let fail = true;
  const calls: string[] = [];
  await page.route('**/api/health-watch/connections/checks', (route) => {
    calls.push('check');
    return fail
      ? route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'the daemon is busy' } } })
      : route.fulfill({ status: 202, json: {} });
  });
  await open(page);
  await page.getByRole('button', { name: 'Check now' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'The check could not run:' });
  await expect(alert).toContainText('the daemon is busy');
  fail = false;
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(alert).toHaveCount(0);
  expect(calls).toHaveLength(2);
});

test('a daemon that does not answer /health-watch leaves the page without a strip or banner, and not broken', async ({
  page,
}) => {
  await mock(page, overview(FAILING), { fail: true });
  await open(page);
  await expect(page.getByRole('listitem', { name: 'pg-tenant' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Auto-check' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Needs attention' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('two failing connections show a banner with why and since when, and each row its pill, history, Retry and Edit credentials', async ({
  page,
}) => {
  const state = await mock(page, overview(FAILING));
  await open(page);

  const banner = page.getByRole('region', { name: 'Needs attention' });
  await expect(banner).toContainText('2 connections need attention');
  await expect(banner).toContainText('password authentication failed');
  await expect(banner).toContainText(`since ${clock(FAILING[0]?.failing_since as unknown as string)}`);
  await expect(banner).toContainText('connection timed out');
  // Three or fewer are listed one by one, with nothing to fold.
  await expect(banner.getByRole('button', { name: 'Show all' })).toHaveCount(0);
  await expect(banner.getByRole('list', { name: 'Failing items' }).getByRole('listitem')).toHaveCount(2);

  const auth = page.getByRole('listitem', { name: 'pg-tenant' });
  await expect(auth).toContainText('FAILING 14 min');
  await expect(auth).toContainText('password authentication failed');
  await expect(auth.locator('i[data-status]')).toHaveCount(4);
  await expect(auth.locator('i[data-status="auth"]')).toHaveCount(2);
  await expect(auth.locator('i[data-status="ok"]').first()).toHaveAttribute('title', /\d\d:\d\d · ok/);
  await expect(auth.locator('i[data-status="auth"]').first()).toHaveAttribute('title', /· needs sign-in/);
  await expect(auth).toContainText('checked 2 min ago');
  await expect(auth).toHaveClass(/bg-accent-100/);

  const down = page.getByRole('listitem', { name: 'mongo-prod' });
  await expect(down).toContainText('FAILING 40 min');
  await expect(down.locator('i[data-status="fail"]')).toHaveCount(3);
  await expect(down.getByRole('button', { name: 'Edit credentials' })).toHaveCount(0);
  await down.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => state.calls).toEqual(['/connections/c2/checks']);

  const fine = page.getByRole('listitem', { name: 'redis-local' });
  await expect(fine).not.toContainText('FAILING');
  await expect(fine.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(fine).not.toHaveClass(/bg-accent-100/);

  await auth.getByRole('button', { name: 'Edit credentials' }).click();
  await expect(page).toHaveURL(/connection=c1/);
});

/** Fifteen connections down for two reasons: ten timed out, five refused the password. */
const MANY = Array.from({ length: 15 }, (_, index) => {
  const timedOut = index < 10;
  return item('connections', 'connection', `m${index}`, `db-${String(index).padStart(2, '0')}`, {
    status: timedOut ? 'fail' : 'auth',
    detail: timedOut ? 'connection timed out' : 'password authentication failed',
    failing_since: ago(timedOut ? 60 - index : 20 - index),
    latency_ms: null,
    history: points('ok', timedOut ? 'fail' : 'auth', timedOut ? 'fail' : 'auth'),
  });
});

test('fifteen failing connections fold into reasons: two lines, name chips, and Show all opens the full list', async ({
  page,
}) => {
  await mock(page, overview(MANY));
  await open(page);

  const banner = page.getByRole('region', { name: 'Needs attention' });
  await expect(banner).toContainText('15 connections need attention');
  const reasons = banner.getByRole('list', { name: 'Reasons' }).getByRole('listitem');
  await expect(reasons).toHaveCount(2);
  await expect(reasons.nth(0)).toContainText('connection timed out');
  await expect(reasons.nth(0)).toContainText('db-00');
  await expect(reasons.nth(0)).toContainText('db-02');
  await expect(reasons.nth(0)).not.toContainText('db-03');
  await expect(reasons.nth(0)).toContainText('+7 more');
  await expect(reasons.nth(0)).toContainText(`since ${clock(MANY[0]?.failing_since as unknown as string)}`);
  await expect(reasons.nth(1)).toContainText('password authentication failed');
  await expect(reasons.nth(1)).toContainText('+2 more');
  await expect(banner.locator('[title]')).toHaveCount(0);
  await expect(banner.getByRole('list', { name: 'Failing items' })).toHaveCount(0);
  expect((await banner.boundingBox())?.height).toBeLessThan(130);

  await banner.getByRole('button', { name: 'Show all' }).click();
  const full = banner.getByRole('list', { name: 'Failing items' });
  await expect(full.getByRole('listitem')).toHaveCount(15);
  await expect(banner.getByRole('list', { name: 'Reasons' })).toHaveCount(0);
  await expect(banner.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  const box = await full.boundingBox();
  expect(box?.height).toBeLessThanOrEqual(241);
  await banner.getByRole('button', { name: 'Show less' }).click();
  await expect(banner.getByRole('list', { name: 'Reasons' })).toBeVisible();
});

test('a third reason collapses into "and N more reasons"', async ({ page }) => {
  const three = [
    ...MANY.slice(0, 4),
    ...MANY.slice(10, 12),
    item('connections', 'connection', 'z1', 'db-zz', {
      status: 'fail',
      detail: 'host not found',
      failing_since: ago(5),
    }),
  ];
  await mock(page, overview(three));
  await open(page);
  const banner = page.getByRole('region', { name: 'Needs attention' });
  await expect(banner.getByRole('list', { name: 'Reasons' }).getByRole('listitem')).toHaveCount(3);
  await expect(banner).toContainText('and 1 more reasons');
});

test('one failing connection is named in the headline', async ({ page }) => {
  await mock(page, overview([FAILING[1], FAILING[2]]));
  await open(page);
  await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText('mongo-prod needs attention');
});

test('a connection that answers again shows RECOVERED and when it was down; all answering shows the green banner', async ({
  page,
}) => {
  const downAt = ago(50);
  const recovered = item('connections', 'connection', 'c2', 'mongo-prod', {
    kind: 'mongodb',
    recovered_at: ago(10),
    history: [
      { status: 'ok', at: ago(60) },
      { status: 'fail', at: downAt },
      { status: 'fail', at: ago(30) },
      { status: 'ok', at: ago(10) },
    ],
  });
  await mock(page, overview([item('connections', 'connection', 'c1', 'pg-tenant'), recovered]));
  await open(page);

  const row = page.getByRole('listitem', { name: 'mongo-prod' });
  await expect(row).toContainText('RECOVERED');
  await expect(row).toContainText(`was down ${clock(downAt)}–${clock(recovered.recovered_at as unknown as string)}`);
  await expect(page.getByRole('listitem', { name: 'pg-tenant' })).not.toContainText('RECOVERED');
  const banner = page.getByRole('status').filter({ hasText: 'Everything answers.' });
  await expect(banner).toContainText('2 connections checked.');
  await expect(page.getByRole('region', { name: 'Needs attention' })).toHaveCount(0);
});

const server = (name: string, change: Record<string, unknown> = {}) => ({
  name,
  scope: 'user',
  repo_id: null,
  transport: 'http',
  target: 'https://mcp.example.com/mcp',
  config_file: '~/.claude.json',
  auth: 'oauth',
  status: 'ok',
  status_detail: null,
  tools: ['search'],
  tool_count: 1,
  env_keys: [],
  has_headers: false,
  enabled: true,
  registered: true,
  used_by: null,
  ...change,
});

const github = {
  id: 'github',
  name: 'GitHub',
  via: 'gh CLI + GitHub MCP',
  status: 'fail',
  status_detail: 'token expired',
  account_label: 'octo',
  login: 'octo',
  config: {},
  last_checked_at: ago(3),
  sign_in: null,
};

async function integrations(page: Page, items: unknown[]) {
  const state = await mock(page, overview(items));
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [github], meta: { next_cursor: null } } }),
  );
  await page.route('**/api/mcp-servers', (route) =>
    route.fulfill({
      json: {
        data: [server('sentry-tools', { status: 'auth' }), server('docs-search')],
        meta: { next_cursor: null, connection_server_count: 0 },
      },
    }),
  );
  await page.route('**/api/mcp-servers/sentry-tools/auth', (route) => {
    state.calls.push('auth sentry-tools');
    return route.fulfill({ status: 204 });
  });
  return state;
}

test('Integrations shows the banner with each item’s own Sign in or Reconnect, and the pill and history on its rows', async ({
  page,
}) => {
  const items = [
    item('integrations', 'mcp_server', 'sentry-tools', 'sentry-tools', {
      kind: 'mcp',
      status: 'auth',
      detail: 'needs a sign-in',
      failing_since: ago(25),
      history: points('ok', 'auth', 'auth'),
    }),
    item('integrations', 'connector', 'github', 'GitHub', {
      kind: 'github',
      status: 'fail',
      detail: 'token expired',
      failing_since: ago(5),
      history: points('ok', 'ok', 'fail'),
    }),
    item('integrations', 'mcp_server', 'docs-search', 'docs-search', { kind: 'mcp' }),
  ];
  const state = await integrations(page, items);
  await open(page, '/integrations');

  const banner = page.getByRole('region', { name: 'Needs attention' });
  await expect(banner).toContainText('2 integrations need attention');
  await expect(banner).toContainText('needs a sign-in');
  await expect(banner).toContainText('token expired');
  await banner.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => state.calls).toEqual(['auth sentry-tools']);
  await banner.getByRole('button', { name: 'Reconnect' }).click();
  await expect(page).toHaveURL(/open=connector%3Agithub/);

  const sentry = page.getByRole('listitem', { name: 'sentry-tools' });
  await expect(sentry).toContainText('FAILING 25 min');
  await expect(sentry.locator('i[data-status="auth"]')).toHaveCount(2);
  await expect(sentry.getByRole('button', { name: 'Sign in' })).toBeVisible();
  const connector = page.getByRole('listitem', { name: 'GitHub' });
  await expect(connector).toContainText('FAILING 5 min');
  await expect(connector.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  await expect(page.getByRole('listitem', { name: 'docs-search' })).not.toContainText('FAILING');
});

test('items that never answered are off: no banner, no pill, no history line, no sidebar count', async ({ page }) => {
  const off = {
    ...github,
    status: 'off',
    status_detail: null,
    account_label: null,
    login: null,
    last_checked_at: null,
  };
  const items = [
    item('integrations', 'connector', 'github', 'GitHub', {
      status: 'off',
      detail: null,
      failing_since: null,
      last_checked_at: ago(3),
      history: points('off', 'off'),
    }),
    item('integrations', 'mcp_server', 'docs-search', 'docs-search', { status: 'off', failing_since: null }),
  ];
  await integrations(page, items);
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [off], meta: { next_cursor: null } } }),
  );
  await open(page, '/integrations');

  const row = page.getByRole('listitem', { name: 'GitHub' });
  await expect(row).toContainText('○ not connected');
  await expect(row).not.toContainText('FAILING');
  await expect(row.locator('i[data-status]')).toHaveCount(0);
  await expect(row).not.toContainText('checked');
  await expect(page.getByRole('region', { name: 'Needs attention' })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Everything answers.' })).toHaveCount(0);
  await expect(page.getByRole('navigation').getByTitle(/failing their automatic check/)).toHaveCount(0);
});

test('the sidebar counts failing items in red on Connections and Integrations, and nothing at zero', async ({
  page,
}) => {
  const state = await mock(
    page,
    overview([
      ...FAILING,
      item('integrations', 'connector', 'github', 'GitHub', { status: 'fail', failing_since: ago(5) }),
    ]),
  );
  await open(page);
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: /Connections/ }).getByTitle('2 Connections failing')).toHaveText('2', {
    useInnerText: true,
  });
  const integrationsBadge = nav.getByRole('link', { name: /Integrations/ }).getByTitle(/failing their automatic check/);
  await expect(integrationsBadge).toHaveText('1');
  await expect(integrationsBadge).toHaveClass(/bg-accent/);

  state.overview = overview([item('connections', 'connection', 'c3', 'redis-local')]);
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(nav.getByTitle(/failing their automatic check/)).toHaveCount(0);
});

/** A browser that allows alerts, and records each one it is asked to show. */
const STUB_ALERTS = () => {
  const shown: { title: string; body: string }[] = [];
  (window as unknown as { shown: typeof shown }).shown = shown;
  document.hasFocus = () => false;
  Object.defineProperty(window, 'Notification', {
    value: class {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      constructor(title: string, options?: { body?: string }) {
        shown.push({ title, body: options?.body ?? '' });
      }
    },
  });
};

const changed = (data: Record<string, unknown>) =>
  JSON.stringify({
    event: 'health.changed',
    at: new Date().toISOString(),
    data: { area: 'connections', target: 'connection', id: 'c2', name: 'mongo-prod', ...data },
  });

test('a desktop alert shows when a connection starts failing and when it recovers, only with the switch on', async ({
  page,
}) => {
  await page.addInitScript(STUB_ALERTS);
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/ws', (ws) => {
    socket = ws;
  });
  await mock(page, overview(FAILING));
  await open(page);
  await expect.poll(() => socket !== undefined).toBe(true);
  const shown = () => page.evaluate(() => (window as unknown as { shown: unknown[] }).shown);
  const failing = changed({
    status: 'fail',
    detail: 'connection timed out',
    since: '2026-11-06T14:05:00.000Z',
    recovered: false,
  });

  // Off by default: nothing shows.
  socket?.send(failing);
  await page.waitForTimeout(300);
  expect(await shown()).toEqual([]);

  await page.evaluate(() => localStorage.setItem('ops-console:notify.alert-health', 'true'));
  socket?.send(failing);
  await expect.poll(shown).toEqual([
    {
      title: 'Connection failing: mongo-prod',
      body: expect.stringMatching(/^connection timed out\. Failing since \d\d:\d\d$/),
    },
  ]);
  socket?.send(changed({ status: 'ok', detail: null, since: null, recovered: true }));
  await expect.poll(async () => ((await shown()) as unknown[]).length).toBe(2);
  expect(((await shown()) as unknown[])[1]).toEqual({ title: 'Recovered: mongo-prod', body: 'Answers again.' });

  socket?.send(
    changed({
      area: 'integrations',
      target: 'mcp_server',
      name: 'sentry-tools',
      status: 'auth',
      detail: 'sign in',
      since: '2026-11-06T14:05:00.000Z',
      recovered: false,
    }),
  );
  await expect
    .poll(async () => ((await shown()) as { title: string }[]).at(-1)?.title)
    .toBe('Integration failing: sentry-tools');
});

test('a health.changed event refetches the overview', async ({ page }) => {
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/ws', (ws) => {
    socket = ws;
  });
  const state = await mock(page, overview(FAILING));
  await open(page);
  await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText('2 connections need attention');
  await expect.poll(() => socket !== undefined).toBe(true);
  state.overview = overview([FAILING[1], FAILING[2]]);
  socket?.send(changed({ status: 'ok', detail: null, since: null, recovered: true }));
  await expect(page.getByRole('region', { name: 'Needs attention' })).toContainText('mongo-prod needs attention');
});

test('screenshots: fifteen failing connections, and the interval menu open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mock(page, overview(MANY));
  await open(page);
  await expect(page.getByRole('region', { name: 'Needs attention' })).toBeVisible();
  await page.getByRole('button', { name: 'Check every' }).click();
  await expect(page.getByRole('listbox', { name: 'Check every' })).toBeVisible();
  await page.screenshot({ path: '/tmp/health-many-menu-1440.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Show all' }).click();
  await page.screenshot({ path: '/tmp/health-many-open-1440.png' });
});

for (const width of [1440, 1024]) {
  test(`Connections and Integrations with failing items read whole at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await integrations(page, [
      ...FAILING,
      item('integrations', 'mcp_server', 'sentry-tools', 'sentry-tools', {
        kind: 'mcp',
        status: 'auth',
        detail: 'needs a sign-in',
        failing_since: ago(25),
        history: points('ok', 'auth', 'auth'),
      }),
      item('integrations', 'connector', 'github', 'GitHub', {
        status: 'fail',
        detail: 'token expired',
        failing_since: ago(5),
        history: points('ok', 'ok', 'fail'),
      }),
    ]);
    await open(page);
    await expect(page.getByRole('region', { name: 'Needs attention' })).toBeVisible();
    await page.screenshot({ path: `/tmp/health-connections-${width}.png` });
    await open(page, '/integrations');
    await expect(page.getByRole('region', { name: 'Needs attention' })).toBeVisible();
    await page.screenshot({ path: `/tmp/health-integrations-${width}.png` });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
}
