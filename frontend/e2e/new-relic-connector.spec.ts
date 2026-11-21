import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const SIGN_IN_URL = 'https://login.example.com/authorize';
// The detail the pane never reads: it asks for a pick when the Connector says `pick`.
const PICK_DETAIL = 'The sign-in finished.';

const CONFIG = {
  account_id: '',
  region: 'US',
  environments: ['prod'],
  daily_scan_time: '09:00',
  default_interval: '24h',
  rapid_errors_per_10m: 100,
  failing_errors_per_hour: 5,
  ignore: [],
  reports_folder: 'reports',
};

const newRelic = (extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => ({
  id: 'new_relic_logs',
  name: 'New Relic logs',
  via: 'New Relic MCP',
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

async function openPane(page: Page, connector: ReturnType<typeof newRelic>, action: string) {
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [connector], meta: { next_cursor: null } } }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const main = page.getByRole('main');
  await main
    .getByRole('listitem', { name: 'New Relic logs' })
    .getByRole('button', { name: action, exact: true })
    .click();
  return { main, pane: main.getByRole('complementary', { name: 'Integration' }) };
}

/** The radio is hidden inside its label, so a click goes to the label text. */
async function pick(pane: Locator, option: string) {
  await pane.getByText(option, { exact: true }).click();
  await expect(pane.getByRole('radio', { name: option })).toBeChecked();
}

const connectButton = (pane: Locator) => pane.getByRole('button', { name: /^(Connect|Reconnect)$/ });
const sentConnect = (page: Page) =>
  page.waitForRequest((request) => request.url().endsWith('/api/connectors/new_relic_logs/connect'));

const ACCOUNTS = [
  { id: '2222222', name: 'Staging' },
  { id: '1111111', name: 'Production' },
  { id: '3333333', name: 'Audit' },
];

test('New Relic logs is not connected at first: only the Region is asked, US by default, and the pane warns of the macOS password prompt', async ({
  page,
}) => {
  const { main, pane } = await openPane(page, newRelic(), 'Connect');
  await expect(pane.getByText('Connect New Relic logs to Ops Console')).toBeVisible();
  await expect(pane.getByText('Reached through New Relic MCP.')).toBeVisible();
  await expect(pane.getByText('○ not connected')).toBeVisible();
  await expect(main.getByRole('listitem', { name: 'New Relic logs' })).toContainText('○ not connected');

  await expect(pane.getByRole('radio', { name: 'US' })).toBeChecked();
  await expect(pane.getByRole('radio', { name: 'EU' })).not.toBeChecked();
  await expect(pane.getByRole('radio', { name: 'JP' })).not.toBeChecked();
  await expect(pane.getByRole('textbox')).toHaveCount(0);
  await expect(pane.getByLabel('API key')).toHaveCount(0);
  await expect(pane.getByText(/macOS may ask for this Mac's login password once/)).toBeVisible();
  await expect(connectButton(pane)).toBeEnabled();
});

for (const region of ['US', 'EU', 'JP']) {
  test(`Connect sends region ${region}`, async ({ page }) => {
    const connector = newRelic();
    await page.route('**/api/connectors/new_relic_logs/connect', (route) => {
      connector.sign_in = { code: null, url: SIGN_IN_URL };
      return route.fulfill({ status: 202 });
    });
    const { pane } = await openPane(page, connector, 'Connect');
    await pick(pane, region);

    const sent = sentConnect(page);
    await connectButton(pane).click();
    expect((await sent).postDataJSON()).toEqual({ region });
    await expect(pane.getByText('◌ signing in')).toBeVisible();
  });
}

test('the saved Region shows chosen, and signing in waits with the link and Cancel', async ({ page }) => {
  const connector = newRelic({ sign_in: { code: null, url: SIGN_IN_URL } }, { region: 'EU' });
  await page.route('**/api/connectors/new_relic_logs/sign-in', (route) => {
    connector.sign_in = null;
    return route.fulfill({ json: { data: connector } });
  });
  const { main, pane } = await openPane(page, connector, 'Connect');
  await expect(pane.getByRole('radio', { name: 'EU' })).toBeChecked();
  await expect(pane.getByRole('radio', { name: 'US' })).toBeDisabled();
  await expect(pane.getByRole('button', { name: 'Waiting…' })).toBeDisabled();
  await expect(pane.getByRole('link', { name: /Open New Relic logs/ })).toHaveAttribute('href', SIGN_IN_URL);
  await pane.getByRole('button', { name: 'Cancel' }).click();
  await expect(pane.getByRole('button', { name: 'Waiting…' })).toHaveCount(0);
  await expect(main.getByRole('listitem', { name: 'New Relic logs' })).toContainText('○ not connected');
});

test('an account picker shows after sign-in, A to Z, and picking one sends the Region and the account', async ({
  page,
}) => {
  const connector = newRelic({ status: 'auth', status_detail: PICK_DETAIL, pick: 'account' }, { region: 'EU' });
  await page.route('**/api/connectors/new_relic_logs/accounts', (route) =>
    route.fulfill({ json: { data: ACCOUNTS, meta: { next_cursor: null } } }),
  );
  await page.route('**/api/connectors/new_relic_logs/connect', (route) => {
    Object.assign(connector, {
      status: 'ok',
      status_detail: null,
      pick: null,
      account_label: 'Production',
      config: { ...connector.config, account_id: '1111111' },
    });
    return route.fulfill({ status: 202 });
  });
  const { pane } = await openPane(page, connector, 'Reconnect');

  const picker = pane.getByRole('region', { name: 'Choose a New Relic account' });
  await expect(picker).toBeVisible();
  await expect(pane.getByRole('alert')).toHaveCount(0);
  await picker.getByRole('button', { name: 'New Relic account' }).click();
  await expect(page.getByRole('option')).toHaveText([/^Choose an account…/, /^Audit/, /^Production/, /^Staging/]);

  const sent = sentConnect(page);
  await page.getByRole('option', { name: 'Production' }).click();
  expect((await sent).postDataJSON()).toEqual({ region: 'EU', account_id: '1111111' });

  await expect(pane.getByText('● connected')).toBeVisible();
  await expect(pane.getByRole('region', { name: 'Choose a New Relic account' })).toHaveCount(0);
  await expect(pane.getByText('Production').first()).toBeVisible();
});

test('an account list that cannot be read shows the daemon reason', async ({ page }) => {
  await page.route('**/api/connectors/new_relic_logs/accounts', (route) =>
    route.fulfill(error(409, 'invalid_state', 'New Relic logs is not signed in')),
  );
  const { pane } = await openPane(
    page,
    newRelic({ status: 'auth', status_detail: PICK_DETAIL, pick: 'account' }),
    'Reconnect',
  );
  await expect(pane.getByRole('region', { name: 'Choose a New Relic account' }).getByRole('alert')).toHaveText(
    'New Relic logs is not signed in',
  );
});

test('a connected Connector shows its account and Region, and Reconnect sends the Region only', async ({ page }) => {
  const connector = newRelic({ status: 'ok', account_label: 'Production' }, { account_id: '1111111', region: 'EU' });
  await page.route('**/api/connectors/new_relic_logs/connect', (route) => route.fulfill({ status: 202 }));
  const { pane } = await openPane(page, connector, 'Manage');
  await expect(pane.getByText('● connected')).toBeVisible();
  await expect(pane.getByText('Production').first()).toBeVisible();
  await expect(pane.getByRole('radio', { name: 'EU' })).toBeChecked();
  const sent = sentConnect(page);
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toEqual({ region: 'EU' });
});

test('after a Disconnect the Region stays for the next Connect', async ({ page }) => {
  const connector = newRelic({ status: 'ok', account_label: 'Production' }, { account_id: '1111111', region: 'JP' });
  await page.route('**/api/connectors/new_relic_logs/credentials', (route) => {
    Object.assign(connector, { status: 'off', account_label: null });
    return route.fulfill({ json: { data: connector } });
  });
  const { main, pane } = await openPane(page, connector, 'Manage');
  await pane.getByRole('button', { name: 'Disconnect…' }).click();
  await expect(pane.getByText(/removes the New Relic MCP Server/)).toBeVisible();
  await expect(pane.getByText(/Keychain|secret|API key/i)).toHaveCount(0);
  await expect(pane.getByText(/Signs out/)).toHaveCount(0);
  await pane.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(main.getByRole('listitem', { name: 'New Relic logs' })).toContainText('○ not connected');

  await main
    .getByRole('listitem', { name: 'New Relic logs' })
    .getByRole('button', { name: 'Connect', exact: true })
    .click();
  await expect(pane.getByRole('radio', { name: 'JP' })).toBeChecked();
});

test('a Connect the daemon refuses shows its message and leaves the Connector unconnected', async ({ page }) => {
  const message = 'New Relic sign-in did not finish';
  await page.route('**/api/connectors/new_relic_logs/connect', (route) =>
    route.fulfill(error(409, 'invalid_state', message)),
  );
  const { pane } = await openPane(page, newRelic(), 'Connect');
  await connectButton(pane).click();
  await expect(pane.getByRole('alert')).toHaveText(message);
  await expect(pane.getByText('○ not connected')).toBeVisible();
});

test('Connect shows checking while the health check runs and cannot be pressed again', async ({ page }) => {
  const { main, pane } = await openPane(
    page,
    newRelic({ status: 'checking', account_label: 'Production' }, { account_id: '1111111' }),
    'Manage',
  );
  await expect(pane.getByText('◌ checking')).toBeVisible();
  await expect(connectButton(pane)).toBeDisabled();
  await expect(main.getByRole('listitem', { name: 'New Relic logs' })).toContainText('◌ checking');
});

test('a Connector that needs auth shows the reason and Reconnect, and no Sign in', async ({ page }) => {
  const detail = 'Sign in again to use the New Relic MCP server.';
  const { main, pane } = await openPane(
    page,
    newRelic({ status: 'auth', status_detail: detail }, { region: 'EU' }),
    'Reconnect',
  );
  await expect(pane.getByRole('alert')).toHaveText(detail);
  await expect(pane.getByRole('region', { name: 'Choose a New Relic account' })).toHaveCount(0);
  await expect(main.getByRole('listitem', { name: 'New Relic logs' })).toContainText('needs auth');
  await expect(main.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(connectButton(pane)).toHaveText('Reconnect');
  await expect(connectButton(pane)).toBeEnabled();
});

test('a Connector that is down shows the reason on the pane and failed on the row', async ({ page }) => {
  const detail = 'Could not reach New Relic: connection refused';
  const { main, pane } = await openPane(
    page,
    newRelic({ status: 'fail', status_detail: detail }, { account_id: '1111111' }),
    'Reconnect',
  );
  await expect(pane.getByRole('alert')).toHaveText(detail);
  await expect(main.getByRole('listitem', { name: 'New Relic logs' })).toContainText('✕ failed');
});
