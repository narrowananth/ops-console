import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const KEY = 'rnd_example_key_123';
const KEY_PAGE = 'https://dashboard.render.com/u/settings?add-api-key';
const NOTE =
  'Create the key with Read only to let Sessions read your services, deploys and logs, or with Read and write to let approved changes run. A change asks you first, a deploy or an environment change always asks, and Full access skips the first.';

const render = (extra: Record<string, unknown> = {}) => ({
  id: 'render',
  name: 'Render',
  via: 'Render MCP',
  status: 'off',
  status_detail: null as string | null,
  account_label: null,
  login: null,
  config: {},
  last_checked_at: null,
  sign_in: null as { code: string | null; url: string | null } | null,
  pick: null,
  ...extra,
});

const error = (status: number, code: string, message: string) => ({ status, json: { error: { code, message } } });

async function openPane(page: Page, connector: ReturnType<typeof render>, action: string) {
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [connector], meta: { next_cursor: null } } }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const main = page.getByRole('main');
  await main.getByRole('listitem', { name: 'Render' }).getByRole('button', { name: action, exact: true }).click();
  return { main, pane: main.getByRole('complementary', { name: 'Integration' }) };
}

const connectButton = (pane: Locator) => pane.getByRole('button', { name: /^(Connect|Reconnect)$/ });
const keyField = (pane: Locator) => pane.getByLabel('Render API key');

test('Render is not connected at first: a masked key field, the dashboard link, the note, and Connect waits for a key', async ({
  page,
}) => {
  const { main, pane } = await openPane(page, render(), 'Connect');
  await expect(pane.getByText('Connect Render to Ops Console')).toBeVisible();
  await expect(pane.getByText('Reached through Render MCP.')).toBeVisible();
  await expect(main.getByRole('listitem', { name: 'Render' })).toContainText('○ not connected');
  await expect(keyField(pane)).toHaveAttribute('type', 'password');
  await expect(pane.getByRole('link', { name: /Create an API key in the Render dashboard/ })).toHaveAttribute(
    'href',
    KEY_PAGE,
  );
  await expect(pane.getByText(NOTE)).toBeVisible();
  await expect(connectButton(pane)).toBeDisabled();
  await keyField(pane).fill('   ');
  await expect(connectButton(pane)).toBeDisabled();
  await keyField(pane).fill(KEY);
  await expect(connectButton(pane)).toBeEnabled();
});

test('Connect sends the trimmed key, the field empties, and the pane shows Reconnect and Disconnect once it is connected', async ({
  page,
}) => {
  const connector = render();
  await page.route('**/api/connectors/render/connect', (route) => {
    Object.assign(connector, { status: 'ok' });
    return route.fulfill({ status: 202 });
  });
  const { main, pane } = await openPane(page, connector, 'Connect');
  await keyField(pane).fill(`  ${KEY}  `);
  const sent = page.waitForRequest((request) => request.url().endsWith('/api/connectors/render/connect'));
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toEqual({ api_key: KEY });

  await expect(keyField(pane)).toHaveValue('');
  await expect(pane.getByRole('button', { name: 'Reconnect' })).toBeDisabled();
  await keyField(pane).fill('rnd_new_key_456');
  await expect(pane.getByRole('button', { name: 'Reconnect' })).toBeEnabled();
  await expect(pane.getByRole('button', { name: 'Disconnect…' })).toBeVisible();
  await expect(main.getByRole('listitem', { name: 'Render' })).toContainText('Manage');
});

test('while the connection waits the field and Connect are disabled and Cancel stops it', async ({ page }) => {
  const connector = render({ sign_in: { code: null, url: null } });
  await page.route('**/api/connectors/render/sign-in', (route) => {
    connector.sign_in = null;
    return route.fulfill({ json: { data: connector } });
  });
  const { main, pane } = await openPane(page, connector, 'Connect');
  await expect(pane.getByText('◌ signing in')).toBeVisible();
  await expect(keyField(pane)).toBeDisabled();
  await expect(pane.getByRole('button', { name: 'Waiting…' })).toBeDisabled();
  await pane.getByRole('button', { name: 'Cancel' }).click();
  await expect(pane.getByRole('button', { name: 'Waiting…' })).toHaveCount(0);
  await expect(main.getByRole('listitem', { name: 'Render' })).toContainText('○ not connected');
});

test('Disconnect says to delete the key in the Render dashboard', async ({ page }) => {
  const connector = render({ status: 'ok' });
  await page.route('**/api/connectors/render/credentials', (route) => {
    Object.assign(connector, { status: 'off' });
    return route.fulfill({ json: { data: connector } });
  });
  const { main, pane } = await openPane(page, connector, 'Manage');
  await expect(pane.getByText('● connected')).toBeVisible();
  await pane.getByRole('button', { name: 'Disconnect…' }).click();
  await expect(pane.getByText(/delete it in the Render dashboard/)).toBeVisible();
  await expect(pane.getByText(/Your services and databases stay as they are/)).toBeVisible();
  await pane.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(main.getByRole('listitem', { name: 'Render' })).toContainText('○ not connected');
});

test("a key Render refuses reads needs auth with Render's reason, and Reconnect takes a new key", async ({ page }) => {
  const reason = 'default: Unauthorized: invalid API key';
  const { main, pane } = await openPane(page, render({ status: 'auth', status_detail: reason }), 'Reconnect');
  await expect(pane.getByText('◐ needs auth')).toBeVisible();
  await expect(pane.getByRole('alert')).toHaveText(reason);
  await expect(main.getByRole('listitem', { name: 'Render' })).toContainText('Reconnect');
  await expect(connectButton(pane)).toBeDisabled();
  await keyField(pane).fill(KEY);
  await expect(connectButton(pane)).toBeEnabled();
});

test('a server turned off in MCP servers reads failed with the reason, and Connect is offered', async ({ page }) => {
  const { pane } = await openPane(
    page,
    render({ status: 'fail', status_detail: 'render is turned off in MCP servers' }),
    'Reconnect',
  );
  await expect(pane.getByText('✕ failed')).toBeVisible();
  await expect(pane.getByRole('alert')).toHaveText('render is turned off in MCP servers');
  await keyField(pane).fill(KEY);
  await expect(connectButton(pane)).toBeEnabled();
});

test('a refused Connect shows the daemon’s message and keeps nothing typed in the field', async ({ page }) => {
  await page.route('**/api/connectors/render/connect', (route) =>
    route.fulfill(error(400, 'validation_failed', 'invalid body: api_key')),
  );
  const { pane } = await openPane(page, render(), 'Connect');
  await keyField(pane).fill(KEY);
  await connectButton(pane).click();
  await expect(pane.getByRole('alert')).toHaveText('invalid body: api_key');
  await expect(keyField(pane)).toHaveValue('');
});
