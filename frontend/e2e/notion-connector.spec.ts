import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const SIGN_IN_URL = 'https://mcp.notion.com/authorize';
const NOTE =
  "Sessions can read your workspace. A change asks you first, a delete always asks, and Full access skips the first. Notion's own limits apply: 180 requests a minute, 600 on Business and Enterprise.";

const notion = (extra: Record<string, unknown> = {}) => ({
  id: 'notion',
  name: 'Notion',
  via: 'Notion MCP',
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

async function openPane(page: Page, connector: ReturnType<typeof notion>, action: string) {
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [connector], meta: { next_cursor: null } } }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const main = page.getByRole('main');
  await main.getByRole('listitem', { name: 'Notion' }).getByRole('button', { name: action, exact: true }).click();
  return { main, pane: main.getByRole('complementary', { name: 'Integration' }) };
}

const connectButton = (pane: Locator) => pane.getByRole('button', { name: /^(Connect|Reconnect)$/ });

test('Notion is not connected at first: one sign-in step with nothing to fill in, and the note on what asks', async ({
  page,
}) => {
  const { main, pane } = await openPane(page, notion(), 'Connect');
  await expect(pane.getByText('Connect Notion to Ops Console')).toBeVisible();
  await expect(pane.getByText('Reached through Notion MCP.')).toBeVisible();
  await expect(main.getByRole('listitem', { name: 'Notion' })).toContainText('○ not connected');
  await expect(pane.getByRole('textbox')).toHaveCount(0);
  await expect(pane.getByRole('region', { name: 'Sign in' })).toContainText('Sign in to Notion');
  await expect(pane.getByText(NOTE)).toBeVisible();
  await expect(connectButton(pane)).toBeEnabled();
});

test('Connect sends no body, then the pane waits with the link and Cancel stops it', async ({ page }) => {
  const connector = notion();
  await page.route('**/api/connectors/notion/connect', (route) => {
    connector.sign_in = { code: null, url: SIGN_IN_URL };
    return route.fulfill({ status: 202 });
  });
  await page.route('**/api/connectors/notion/sign-in', (route) => {
    connector.sign_in = null;
    return route.fulfill({ json: { data: connector } });
  });
  const { main, pane } = await openPane(page, connector, 'Connect');
  const sent = page.waitForRequest((request) => request.url().endsWith('/api/connectors/notion/connect'));
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toEqual({});

  await expect(pane.getByText('◌ signing in')).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Waiting…' })).toBeDisabled();
  await expect(pane.getByRole('link', { name: /Open Notion/ })).toHaveAttribute('href', SIGN_IN_URL);
  await expect(pane.getByText(NOTE)).toBeVisible();

  await pane.getByRole('button', { name: 'Cancel' }).click();
  await expect(pane.getByRole('button', { name: 'Waiting…' })).toHaveCount(0);
  await expect(main.getByRole('listitem', { name: 'Notion' })).toContainText('○ not connected');
});

test('connected shows the status, and Disconnect says it signs out of nothing at Notion', async ({ page }) => {
  const connector = notion({ status: 'ok' });
  await page.route('**/api/connectors/notion/credentials', (route) => {
    Object.assign(connector, { status: 'off' });
    return route.fulfill({ json: { data: connector } });
  });
  const { main, pane } = await openPane(page, connector, 'Manage');
  await expect(pane.getByText('● connected')).toBeVisible();
  await expect(pane.getByText(NOTE)).toBeVisible();

  await pane.getByRole('button', { name: 'Disconnect…' }).click();
  await expect(pane.getByText(/Your Notion account and pages stay as they are/)).toBeVisible();
  await pane.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(main.getByRole('listitem', { name: 'Notion' })).toContainText('○ not connected');
});

test("a sign-in Notion does not finish reads needs auth with Notion's reason", async ({ page }) => {
  const reason = 'The authorization request was denied';
  const { pane } = await openPane(page, notion({ status: 'auth', status_detail: reason }), 'Sign in');
  await expect(pane.getByText('◐ needs auth')).toBeVisible();
  await expect(pane.getByRole('alert')).toHaveText(reason);
  await expect(connectButton(pane)).toBeEnabled();
});

test('a Notion server turned off in MCP servers reads failed with the reason, and Connect is offered', async ({
  page,
}) => {
  const { pane } = await openPane(
    page,
    notion({ status: 'fail', status_detail: 'notion is turned off in MCP servers' }),
    'Reconnect',
  );
  await expect(pane.getByText('✕ failed')).toBeVisible();
  await expect(pane.getByRole('alert')).toHaveText('notion is turned off in MCP servers');
  await expect(connectButton(pane)).toBeEnabled();
});
