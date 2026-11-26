import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-10-31T10:00:00.000Z';

const connection = (id: string, name: string, type: string, env: string, access: string) => ({
  id,
  name,
  type,
  env,
  access,
  config: {},
  status: 'ok',
  status_detail: null,
  latency_ms: 4,
  last_checked_at: NOW,
  created_at: NOW,
  is_prod: env === 'prod',
  secret_stored: true,
});

const CONNECTIONS = [
  connection('c1', 'pg-tenant', 'postgres', 'local', 'read'),
  connection('c2', 'mongo-prod', 'mongodb', 'prod', 'read'),
  connection('c3', 'redis-local', 'redis', 'local', 'none'),
];

const SESSION = {
  id: 's1',
  kind: 'devtools',
  title: 'find shop acme',
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'auto',
  account_id: null,
  repo_id: null,
  branch: null,
  pr_number: null,
  pr_action: null,
  connection_ids: ['c1', 'c2'],
  extra_repo_ids: [],
  pull_request: null,
  pull_requests: [],
  alert_id: null,
  state: 'idle',
  last_message_preview: null,
  last_error: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook: null,
  queued_message: null,
  spawned_by: null,
  spawned: [],
  subagents: [],
};

const MESSAGES = [
  { id: 'm1', role: 'user', status: 'done', parts: [{ kind: 'text', text: 'find shop acme' }], created_at: NOW },
  {
    id: 'm2',
    role: 'agent',
    status: 'done',
    created_at: NOW,
    parts: [
      { kind: 'step', text: 'pg-tenant (read-only): execute_sql' },
      {
        kind: 'result',
        connection: 'pg-tenant',
        query: "select id, shop_domain, plan from shops where shop_domain like '%acme%'",
        columns: ['id', 'shop_domain', 'plan'],
        rows: [['4812', 'acme.example.com', 'pro']],
        total: 1,
        ms: 12,
      },
      {
        kind: 'result',
        connection: 'mongo-prod',
        query: null,
        columns: ['shop', 'plan', 'status', 'settings'],
        rows: [['acme', 'growth', 'active', '{"theme":"dark","beta":true}']],
        total: 1,
        ms: 31,
      },
      {
        kind: 'comparison',
        key: 'shop_domain',
        value: 'acme.example.com',
        connections: ['pg-tenant', 'mongo-prod'],
        rows: [
          { field: 'plan', values: ['pro', 'growth'], differs: true },
          { field: 'status', values: ['active', 'active'], differs: false },
        ],
      },
      { kind: 'text', text: '2 rows across 2 of 2 Connections. The plan differs.' },
    ],
  },
];

/** The daemon as an earlier Dev tools Session sees it: listed under its kind, empty under the others. */
async function mock(page: Page) {
  const patches: unknown[] = [];
  await page.route('**/api/connections', (route) =>
    route.fulfill({ json: { data: CONNECTIONS, meta: { next_cursor: null } } }),
  );
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: [], meta: { next_cursor: null } } }));
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind');
    return route.fulfill({ json: { data: kind === 'devtools' ? [SESSION] : [] } });
  });
  await page.route('**/api/sessions/s1/messages', (route) => route.fulfill({ json: { data: MESSAGES } }));
  await page.route(/\/api\/sessions\/s1$/, (route) => {
    if (route.request().method() !== 'PATCH') return route.fulfill({ json: { data: SESSION } });
    patches.push(route.request().postDataJSON());
    return route.fulfill({ json: { data: { ...SESSION, connection_ids: ['c1'] } } });
  });
  return patches;
}

test('the sidebar has no Dev tools, and /devtools, with any query, lands on Sessions', async ({ page }) => {
  await mock(page);
  await page.goto(`${daemon.url}/sessions#token=${daemon.token}`);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Dev tools' })).toHaveCount(0);

  await page.goto(`${daemon.url}/devtools?x=1`);
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(page.getByRole('heading', { name: 'Sessions' }).first()).toBeVisible();
});

test('a saved /devtools address does not bring the removed page back', async ({ page }) => {
  await mock(page);
  await page.goto(`${daemon.url}/sessions#token=${daemon.token}`);
  await page.evaluate(() => {
    localStorage.setItem('ops-console:nav.page', JSON.stringify('/devtools'));
    localStorage.setItem('ops-console:nav.last./devtools', JSON.stringify('/devtools'));
  });
  await page.goto(daemon.url);
  await expect(page).not.toHaveURL(/devtools/);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Dev tools' })).toHaveCount(0);
});

test('an earlier Dev tools Session opens in Sessions with its Connections, and the composer changes them', async ({
  page,
}) => {
  const patches = await mock(page);
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);

  await expect(page.getByText(SESSION.title).first()).toBeVisible();
  const chips = page
    .getByRole('complementary', { name: 'Session' })
    .getByRole('list', { name: 'Connections the agent may reach' });
  await expect(chips.getByRole('listitem')).toHaveText([/mongo-prod\s*PROD/, /pg-tenant/]);

  await page.getByRole('button', { name: /^Connections: / }).click();
  await page
    .locator('[data-session-connections]')
    .getByRole('button', { name: /mongo-prod/ })
    .click();
  await expect.poll(() => patches).toEqual([{ connection_ids: ['c1'] }]);
});

test('a Result per Connection and the Comparison are drawn in the Session, differing rows marked', async ({ page }) => {
  await mock(page);
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);

  const pg = page.getByRole('region', { name: 'Result from pg-tenant' });
  await expect(pg).toContainText('── pg-tenant · Postgres');
  await expect(pg).toContainText('acme.example.com');
  await expect(pg).toContainText('✓ 1 row · 12ms');
  const mongo = page.getByRole('region', { name: 'Result from mongo-prod' });
  await expect(mongo).toContainText('PROD');
  await expect(mongo.getByRole('columnheader')).toHaveText(['field', 'value']);
  await expect(mongo.getByRole('row', { name: /plan/ })).toContainText('growth');
  await expect(mongo.getByRole('row', { name: /settings/ })).toContainText('{\n  "theme": "dark",\n  "beta": true\n}');

  const compared = page.getByRole('region', { name: 'Compared on shop_domain' });
  await expect(compared).toContainText('■ Compared on shop_domain = acme.example.com');
  await expect(compared.getByRole('row', { name: /plan/ })).toContainText('◀ differs');
  await expect(compared.getByRole('row', { name: /status/ })).not.toContainText('◀ differs');
  await expect(compared).toContainText('1 of 2 fields differ.');
  await expect(page.getByText('2 rows across 2 of 2 Connections. The plan differs.')).toBeVisible();
});

test('a PROD Connection can only be read: Read / write greys out, and picking PROD drops it to Read-only', async ({
  page,
}) => {
  await page.route('**/api/connections', (route) => route.fulfill({ json: { data: [], meta: { next_cursor: null } } }));
  await page.goto(`${daemon.url}/connections#token=${daemon.token}`);
  await page.getByRole('button', { name: '+ Add connection' }).click();
  await page.getByRole('button', { name: /^Postgres/ }).click();

  const access = page.getByRole('group', { name: 'Claude access' });
  await access.getByText('Read / write').click();
  await expect(access.getByRole('radio', { name: 'Read / write' })).toBeChecked();
  await page.getByRole('group', { name: 'Environment' }).getByText('prod').click();
  await expect(access.getByRole('radio', { name: 'Read-only' })).toBeChecked();
  await expect(access.getByRole('radio', { name: 'Read / write' })).toBeDisabled();
  await expect(page.getByText('A PROD Connection is read-only: Read / write is off.')).toBeVisible();

  // Firebase has a read-only server now.
  await page.getByRole('button', { name: '← Back' }).click();
  await page.getByRole('button', { name: '+ Add connection' }).click();
  await page.getByRole('button', { name: /^Firebase/ }).click();
  await expect(
    page.getByRole('group', { name: 'Claude access' }).getByRole('radio', { name: 'Read-only' }),
  ).toBeChecked();
  await expect(page.getByLabel('Service account key (JSON or base64)')).toBeVisible();
});
