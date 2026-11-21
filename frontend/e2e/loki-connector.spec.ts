import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const SIGN_IN_URL = 'https://grafana.example.com/oauth/authorize';
// The detail the pane never reads: it asks for a pick when the Connector says `pick`.
const PICK_DETAIL = 'The sign-in finished.';
const SELF_HOSTED_DETAIL = 'Loki on Grafana Cloud only: the self-hosted URL is no longer read.';

const CONFIG = {
  datasource_uid: '',
  environments: ['prod'],
  daily_scan_time: '09:00',
  default_interval: '24h',
  rapid_errors_per_10m: 100,
  failing_errors_per_hour: 5,
  ignore: [],
  reports_folder: 'reports',
};

const loki = (extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => ({
  id: 'loki_logs',
  name: 'Loki logs',
  via: 'Grafana Cloud MCP',
  status: 'off',
  status_detail: null as string | null,
  account_label: null as string | null,
  login: null,
  config: { ...CONFIG, ...config } as Record<string, unknown>,
  last_checked_at: null,
  sign_in: null as { code: string | null; url: string | null } | null,
  pick: null as 'data_source' | 'account' | null,
  ...extra,
});

const error = (status: number, code: string, message: string) => ({ status, json: { error: { code, message } } });

async function openPane(page: Page, connector: ReturnType<typeof loki>, action: string) {
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [connector], meta: { next_cursor: null } } }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const main = page.getByRole('main');
  await main.getByRole('listitem', { name: 'Loki logs' }).getByRole('button', { name: action, exact: true }).click();
  return { main, pane: main.getByRole('complementary', { name: 'Integration' }) };
}

const connectButton = (pane: Locator) => pane.getByRole('button', { name: /^(Connect|Reconnect)$/ });
const sentConnect = (page: Page) =>
  page.waitForRequest((request) => request.url().endsWith('/api/connectors/loki_logs/connect'));

const SOURCES = [
  { id: 'uid-staging', name: 'Staging Loki' },
  { id: 'uid-prod', name: 'Prod Loki' },
  { id: 'uid-audit', name: 'Audit Loki' },
];

test('Loki logs is not connected at first: no field to fill, Connect is ready, and the pane says Grafana Cloud only', async ({
  page,
}) => {
  const { main, pane } = await openPane(page, loki(), 'Connect');
  await expect(pane.getByText('Connect Loki logs to Ops Console')).toBeVisible();
  await expect(pane.getByText('Reached through Grafana Cloud MCP.')).toBeVisible();
  await expect(pane.getByText('○ not connected')).toBeVisible();
  await expect(main.getByRole('listitem', { name: 'Loki logs' })).toContainText('○ not connected');

  await expect(pane.getByRole('textbox')).toHaveCount(0);
  await expect(pane.getByLabel('Secret')).toHaveCount(0);
  await expect(pane.getByRole('radio')).toHaveCount(0);
  await expect(pane.getByRole('region', { name: 'Sign in' })).toBeVisible();
  await expect(pane.getByText(/Grafana Cloud only/)).toBeVisible();
  await expect(connectButton(pane)).toBeEnabled();
});

test('Connect sends no choices, then the pane waits with the link and Cancel, and a second Connect is not offered', async ({
  page,
}) => {
  const connector = loki();
  await page.route('**/api/connectors/loki_logs/connect', (route) => {
    connector.sign_in = { code: null, url: SIGN_IN_URL };
    return route.fulfill({ status: 202 });
  });
  await page.route('**/api/connectors/loki_logs/sign-in', (route) => {
    connector.sign_in = null;
    return route.fulfill({ json: { data: connector } });
  });
  const { main, pane } = await openPane(page, connector, 'Connect');
  const sent = sentConnect(page);
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toEqual({});

  await expect(pane.getByText('◌ signing in')).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Waiting…' })).toBeDisabled();
  await expect(pane.getByRole('link', { name: /Open Loki logs/ })).toHaveAttribute('href', SIGN_IN_URL);

  await pane.getByRole('button', { name: 'Cancel' }).click();
  await expect(pane.getByRole('button', { name: 'Waiting…' })).toHaveCount(0);
  await expect(main.getByRole('listitem', { name: 'Loki logs' })).toContainText('○ not connected');
});

test('a stack with several Loki data sources shows a picker A to Z, and picking one sends it and connects', async ({
  page,
}) => {
  const connector = loki({ status: 'auth', status_detail: PICK_DETAIL, pick: 'data_source' });
  await page.route('**/api/connectors/loki_logs/datasources', (route) =>
    route.fulfill({ json: { data: SOURCES, meta: { next_cursor: null } } }),
  );
  await page.route('**/api/connectors/loki_logs/connect', (route) => {
    Object.assign(connector, {
      status: 'ok',
      status_detail: null,
      pick: null,
      account_label: 'Prod Loki',
      config: { ...connector.config, datasource_uid: 'uid-prod' },
    });
    return route.fulfill({ status: 202 });
  });
  const { pane } = await openPane(page, connector, 'Reconnect');

  const picker = pane.getByRole('region', { name: 'Choose a Loki data source' });
  await expect(picker).toBeVisible();
  await expect(pane.getByRole('alert')).toHaveCount(0);
  await picker.getByRole('button', { name: 'Loki data source' }).click();
  await expect(page.getByRole('option')).toHaveText([
    /^Choose a data source…/,
    /^Audit Loki/,
    /^Prod Loki/,
    /^Staging Loki/,
  ]);

  const sent = sentConnect(page);
  await page.getByRole('option', { name: 'Prod Loki' }).click();
  expect((await sent).postDataJSON()).toEqual({ datasource_uid: 'uid-prod' });

  await expect(pane.getByText('● connected')).toBeVisible();
  await expect(pane.getByRole('region', { name: 'Choose a Loki data source' })).toHaveCount(0);
  await expect(pane.getByText('Prod Loki').first()).toBeVisible();
});

test('a picker that cannot be read shows the daemon reason', async ({ page }) => {
  await page.route('**/api/connectors/loki_logs/datasources', (route) =>
    route.fulfill(error(409, 'invalid_state', 'Loki logs is not signed in')),
  );
  const { pane } = await openPane(
    page,
    loki({ status: 'auth', status_detail: PICK_DETAIL, pick: 'data_source' }),
    'Reconnect',
  );
  await expect(pane.getByRole('region', { name: 'Choose a Loki data source' }).getByRole('alert')).toHaveText(
    'Loki logs is not signed in',
  );
});

test('a Connector that needs auth for another reason shows it with Reconnect and no picker', async ({ page }) => {
  const detail = 'Sign in again to use Grafana Cloud.';
  const { main, pane } = await openPane(page, loki({ status: 'auth', status_detail: detail }), 'Reconnect');
  await expect(pane.getByRole('alert')).toHaveText(detail);
  await expect(pane.getByRole('region', { name: 'Choose a Loki data source' })).toHaveCount(0);
  await expect(main.getByRole('listitem', { name: 'Loki logs' })).toContainText('needs auth');
  await expect(connectButton(pane)).toHaveText('Reconnect');
  await expect(connectButton(pane)).toBeEnabled();
});

test('a Loki that held a self-hosted URL reads needs auth with the Grafana Cloud only note and Reconnect', async ({
  page,
}) => {
  const { main, pane } = await openPane(
    page,
    loki({ status: 'auth', status_detail: SELF_HOSTED_DETAIL }, { datasource_uid: 'loki-main' }),
    'Reconnect',
  );
  await expect(pane.getByRole('alert')).toHaveText(SELF_HOSTED_DETAIL);
  await expect(main.getByRole('listitem', { name: 'Loki logs' })).toContainText('needs auth');
  await expect(connectButton(pane)).toHaveText('Reconnect');
});

test('a connected Loki shows its data source and Reconnect sends no choice', async ({ page }) => {
  const { pane } = await openPane(
    page,
    loki({ status: 'ok', account_label: 'Prod Loki' }, { datasource_uid: 'uid-prod' }),
    'Manage',
  );
  await page.route('**/api/connectors/loki_logs/connect', (route) => route.fulfill({ status: 202 }));
  await expect(pane.getByText('● connected')).toBeVisible();
  await expect(pane.getByText('Prod Loki').first()).toBeVisible();
  const sent = sentConnect(page);
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toEqual({});
});

test('a Connect the daemon refuses shows its message and leaves the Connector unconnected', async ({ page }) => {
  const message = 'Grafana did not finish signing in';
  await page.route('**/api/connectors/loki_logs/connect', (route) =>
    route.fulfill(error(409, 'invalid_state', message)),
  );
  const { pane } = await openPane(page, loki(), 'Connect');
  await connectButton(pane).click();
  await expect(pane.getByRole('alert')).toHaveText(message);
  await expect(pane.getByText('○ not connected')).toBeVisible();
});

test('Connect shows checking while the health check runs and cannot be pressed again', async ({ page }) => {
  const { main, pane } = await openPane(
    page,
    loki({ status: 'checking', account_label: 'Prod Loki' }, { datasource_uid: 'uid-prod' }),
    'Manage',
  );
  await expect(pane.getByText('◌ checking')).toBeVisible();
  await expect(connectButton(pane)).toBeDisabled();
  await expect(main.getByRole('listitem', { name: 'Loki logs' })).toContainText('◌ checking');
});

test('a Connector that is down shows the reason on the pane and failed on the row', async ({ page }) => {
  const detail = 'Could not reach Grafana: connection refused';
  const { main, pane } = await openPane(
    page,
    loki({ status: 'fail', status_detail: detail }, { datasource_uid: 'uid-prod' }),
    'Reconnect',
  );
  await expect(pane.getByRole('alert')).toHaveText(detail);
  await expect(main.getByRole('listitem', { name: 'Loki logs' })).toContainText('✕ failed');
});

test('disconnecting Loki says the sign-in leaves the Keychain and the MCP server goes, with no secret text', async ({
  page,
}) => {
  const connector = loki({ status: 'ok', account_label: 'Prod Loki' }, { datasource_uid: 'uid-prod' });
  await page.route('**/api/connectors/loki_logs/credentials', (route) => {
    Object.assign(connector, { status: 'off', account_label: null });
    return route.fulfill({ json: { data: connector } });
  });
  const { main, pane } = await openPane(page, connector, 'Manage');
  await pane.getByRole('button', { name: 'Disconnect…' }).click();
  await expect(
    pane.getByText(/removes the Grafana MCP Server and the console's sign-in from the Keychain/),
  ).toBeVisible();
  await expect(pane.getByText(/secret/i)).toHaveCount(0);
  await expect(pane.getByText(/Signs out/)).toHaveCount(0);
  await pane.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(main.getByRole('listitem', { name: 'Loki logs' })).toContainText('○ not connected');
});
