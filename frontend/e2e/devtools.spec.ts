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
  connection_ids: [],
  extra_repo_ids: [],
  alert_id: null,
  state: 'idle',
  last_message_preview: null,
  last_error: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook: null,
  queued_message: null,
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

async function mock(page: Page, sessions: unknown[]) {
  await page.route('**/api/connections', (route) =>
    route.fulfill({ json: { data: CONNECTIONS, meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=devtools/, (route) => route.fulfill({ json: { data: sessions } }));
  await page.route('**/api/sessions/s1/messages', (route) => route.fulfill({ json: { data: MESSAGES } }));
}

test('Dev tools opens ready to ask, with the Synced dev tools list and the prompt', async ({ page }) => {
  await mock(page, []);
  await page.goto(`${daemon.url}/devtools#token=${daemon.token}`);

  const tools = page.getByRole('complementary', { name: 'Synced dev tools' });
  await expect(tools.getByRole('button', { name: /All connected/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(tools.getByRole('button', { name: /All connected/ })).toContainText('2');
  await expect(tools.getByRole('button', { name: /mongo-prod/ })).toContainText('PROD');
  await expect(tools.getByRole('button', { name: /redis-local/ })).toBeDisabled();
  await expect(page.getByText('scope: all connected (2)')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Ask the agent' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Open terminal' })).toHaveCount(0);

  await tools.getByRole('button', { name: /pg-tenant/ }).click();
  await expect(page.getByText('scope: pg-tenant')).toBeVisible();
});

test('a new terminal has its Model, Effort and Access chips, and its first question makes the Session with them', async ({
  page,
}) => {
  await mock(page, [SESSION]);
  let created: unknown;
  await page.route('**/api/sessions', (route) => {
    created = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { data: { ...SESSION, id: 's2', title: 'New session' } } });
  });
  await page.route('**/api/sessions/s2/messages', (route) =>
    route.fulfill(
      route.request().method() === 'POST'
        ? { status: 202, json: { data: { message_id: 'm3' } } }
        : { json: { data: [] } },
    ),
  );
  await page.goto(`${daemon.url}/devtools#token=${daemon.token}`);

  await page.getByRole('button', { name: 'New terminal', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'new terminal' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Effort' }).click();
  await page.getByRole('option', { name: /^Max/ }).click();
  await expect(page.getByRole('button', { name: 'Effort' })).toContainText('Max');

  const prompt = page.getByRole('textbox', { name: 'Ask the agent' });
  await prompt.fill('count shops');
  await page.getByRole('button', { name: 'New terminal', exact: true }).click();
  await expect(prompt).toHaveValue('');
  await expect(prompt).toBeFocused();
  await expect(page.getByRole('button', { name: 'Effort' })).not.toContainText('Max');

  const fresh = page.getByRole('tab', { name: 'new terminal' });
  await expect(fresh).toHaveCount(2);
  await page.getByRole('tab', { name: SESSION.title }).click();
  await expect(fresh).toHaveCount(2);
  await fresh.first().click();
  await expect(fresh.first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Effort' })).toContainText('Max');
  await expect(prompt).toHaveValue('count shops');

  await page.reload();
  await expect(fresh).toHaveCount(2);
  await expect(fresh.first()).toHaveAttribute('aria-selected', 'true');
  await expect(prompt).toHaveValue('count shops');
  await expect(page.getByRole('button', { name: 'Effort' })).toContainText('Max');
  await page.getByRole('button', { name: 'Close new terminal' }).last().click();
  await expect(fresh).toHaveCount(1);

  await prompt.press('Shift+Enter');
  await prompt.pressSequentially('and orders');
  await expect(prompt).toHaveValue('count shops\nand orders');
  await expect.poll(() => created).toBeUndefined();
  await prompt.press('Enter');
  await expect.poll(() => created).toMatchObject({ kind: 'devtools', connection_ids: [], effort: 'max' });
});

test('a question across Connections shows a Result per Connection and the Comparison, differing rows marked', async ({
  page,
}) => {
  await mock(page, [SESSION]);
  await page.goto(`${daemon.url}/devtools#token=${daemon.token}`);

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

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  // Chrome's Clipboard API refuses on the click that brings an unfocused window forward; that click still copies.
  await page.evaluate(() => {
    navigator.clipboard.writeText = () =>
      Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError'));
  });
  await compared.getByRole('button', { name: 'Copy JSON' }).click();
  await expect(compared.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied).toMatchObject({ key: 'shop_domain', connections: ['pg-tenant', 'mongo-prod'] });
});

test('a terminal whose agent is working stops, and its tab deletes only once it has', async ({ page }) => {
  let state = 'working';
  const stops: string[] = [];
  await mock(page, []);
  await page.route(/\/api\/sessions\?kind=devtools/, (route) =>
    route.fulfill({ json: { data: [{ ...SESSION, state }] } }),
  );
  await page.route('**/api/sessions/s1/stop', (route) => {
    stops.push(route.request().method());
    state = 'idle';
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${daemon.url}/devtools#token=${daemon.token}`);

  const remove = page.getByRole('button', { name: /^Delete / });
  await expect(remove).toBeDisabled();
  await page.getByRole('button', { name: 'stop', exact: true }).click();
  await expect.poll(() => stops).toEqual(['POST']);
  await expect(page.getByRole('button', { name: 'stop', exact: true })).toHaveCount(0);
  await expect(remove).toBeEnabled();
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

test("changing the scope of a terminal that has a Session works while the tray holds today's usage", async ({
  page,
}) => {
  await mock(page, [SESSION]);
  await page.route('**/api/agent-runs/usage', (route) =>
    route.fulfill({ json: { data: { cost_usd: 1.5, tokens: 1200, runs: 2 } } }),
  );
  let patched: unknown;
  await page.route('**/api/sessions/s1', (route) => {
    patched = route.request().postDataJSON();
    return route.fulfill({ json: { data: { ...SESSION, connection_ids: ['c1'] } } });
  });
  await page.goto(`${daemon.url}/devtools#token=${daemon.token}`);

  await page.getByRole('button', { name: 'Running agents' }).click();
  await expect(page.getByText('today', { exact: false }).first()).toBeVisible();
  await page
    .getByRole('complementary', { name: 'Synced dev tools' })
    .getByRole('button', { name: /pg-tenant/ })
    .click();
  await expect(page.getByText('scope: pg-tenant')).toBeVisible();
  await expect.poll(() => patched).toEqual({ connection_ids: ['c1'] });
  await expect(page.getByText('is not a function')).toBeHidden();
});

test('a paste into the terminal prompt keeps its first 10,000 characters and warns under the terminal', async ({
  page,
}) => {
  await mock(page, []);
  await page.goto(`${daemon.url}/devtools#token=${daemon.token}`);
  const prompt = page.getByRole('textbox', { name: 'Ask the agent' });
  await expect(prompt).toBeEnabled();
  await expect(page.getByRole('status')).toHaveCount(0);

  await prompt.evaluate((element) => {
    element.focus();
    const data = new DataTransfer();
    data.setData('text/plain', 'y'.repeat(12000));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(prompt).toHaveValue('y'.repeat(10000));
  await expect(page.getByRole('status')).toContainText('Only 10,000 characters are allowed at once');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
