import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const ACCOUNT = '1234567';
const KEY = 'NRAK-EXAMPLE';

const CONFIG = {
  account_id: '',
  region: 'US',
  service_attribute: 'service.name',
  env_attribute: 'environment',
  filter: '',
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
  via: 'newrelic CLI',
  status: 'off',
  status_detail: null as string | null,
  account_label: null as string | null,
  login: null,
  config: { ...CONFIG, ...config } as Record<string, unknown>,
  last_checked_at: null,
  sign_in: null,
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

/** A connect answer that stores what the body says, as the daemon does, and never sends the key back. */
async function answerConnect(page: Page, connector: ReturnType<typeof newRelic>, status = 'ok') {
  await page.route('**/api/connectors/new_relic_logs/connect', (route) => {
    const { secret: _secret, ...fields } = route.request().postDataJSON();
    Object.assign(connector, {
      status,
      account_label: fields.account_id,
      config: { ...connector.config, ...fields },
    });
    return route.fulfill({ status: 202 });
  });
}

/** The radio is hidden inside its label, so a click goes to the label text. */
async function pick(pane: Locator, option: string) {
  await pane.getByText(option, { exact: true }).click();
  await expect(pane.getByRole('radio', { name: option })).toBeChecked();
}

const connectButton = (pane: Locator) => pane.getByRole('button', { name: /^(Connect|Reconnect)$/ });
const sentConnect = (page: Page) =>
  page.waitForRequest((request) => request.url().endsWith('/api/connectors/new_relic_logs/connect'));

test('New Relic logs is not connected at first: the pane has the fields with their defaults and Connect waits for an account ID and a key', async ({
  page,
}) => {
  const { main, pane } = await openPane(page, newRelic(), 'Connect');
  await expect(pane.getByText('Connect New Relic logs to Ops Console')).toBeVisible();
  await expect(pane.getByText('Reached through newrelic CLI.')).toBeVisible();
  await expect(pane.getByText('○ not connected')).toBeVisible();
  await expect(main.getByRole('listitem', { name: 'New Relic logs' })).toContainText('○ not connected');

  await expect(pane.getByRole('textbox', { name: 'Account ID' })).toHaveValue('');
  await expect(pane.getByRole('radio', { name: 'US' })).toBeChecked();
  await expect(pane.getByRole('radio', { name: 'EU' })).not.toBeChecked();
  await expect(pane.getByRole('radio', { name: 'JP' })).not.toBeChecked();
  await expect(pane.getByLabel('API key')).toHaveAttribute('type', 'password');
  await expect(pane.getByText('No key set.')).toBeVisible();
  await expect(pane.getByRole('textbox', { name: 'Service attribute' })).toHaveValue('service.name');
  await expect(pane.getByRole('textbox', { name: 'Env attribute' })).toHaveValue('environment');
  await expect(pane.getByRole('textbox', { name: 'Filter' })).toHaveValue('');
  await expect(pane.getByRole('region', { name: 'Sign in' })).toHaveCount(0);

  await expect(pane.getByText(/account ID/i).first()).toBeVisible();
  await expect(pane.getByText(/Access management/)).toBeVisible();
  await expect(pane.getByText(/one region/)).toBeVisible();
  await expect(pane.getByText(/read-only role/)).toBeVisible();

  await expect(connectButton(pane)).toBeDisabled();
  await pane.getByRole('textbox', { name: 'Account ID' }).fill(ACCOUNT);
  await expect(connectButton(pane)).toBeDisabled();
  await pane.getByLabel('API key').fill(KEY);
  await expect(connectButton(pane)).toBeEnabled();
});

test('the attribute fields show their default names in full', async ({ page }) => {
  const { pane } = await openPane(page, newRelic(), 'Connect');
  for (const name of ['Service attribute', 'Env attribute']) {
    const field = pane.getByRole('textbox', { name });
    const clipped = await field.evaluate((input: HTMLInputElement) => input.scrollWidth > input.clientWidth);
    expect(clipped, name).toBe(false);
  }
});

test('connecting sends the fields and the key once, then shows connected with the account ID and never the key', async ({
  page,
}) => {
  const connector = newRelic();
  await answerConnect(page, connector);
  const { main, pane } = await openPane(page, connector, 'Connect');
  await pane.getByRole('textbox', { name: 'Account ID' }).fill(` ${ACCOUNT} `);
  await pane.getByLabel('API key').fill(KEY);
  await pane.getByRole('textbox', { name: 'Filter' }).fill("cluster = 'prod-1'");

  const sent = sentConnect(page);
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toEqual({
    account_id: ACCOUNT,
    region: 'US',
    service_attribute: 'service.name',
    env_attribute: 'environment',
    filter: "cluster = 'prod-1'",
    secret: KEY,
  });

  await expect(pane.getByText('● connected')).toBeVisible();
  await expect(pane.getByText(ACCOUNT).first()).toBeVisible();
  await expect(main.getByRole('listitem', { name: 'New Relic logs' })).toContainText(`newrelic CLI · ${ACCOUNT}`);
  await expect(pane.getByText('Key set in the Keychain.')).toBeVisible();
  await expect(pane.getByLabel('API key')).toHaveValue('');
  await expect(pane.getByRole('textbox', { name: 'Filter' })).toHaveValue("cluster = 'prod-1'");
  await expect(page.getByRole('main')).not.toContainText(KEY);
});

for (const region of ['US', 'EU', 'JP']) {
  test(`connecting sends region ${region}`, async ({ page }) => {
    const connector = newRelic();
    await answerConnect(page, connector);
    const { pane } = await openPane(page, connector, 'Connect');
    await pane.getByRole('textbox', { name: 'Account ID' }).fill(ACCOUNT);
    await pane.getByLabel('API key').fill(KEY);
    await pick(pane, region);

    const sent = sentConnect(page);
    await connectButton(pane).click();
    expect((await sent).postDataJSON()).toMatchObject({ account_id: ACCOUNT, region, secret: KEY });
    await expect(pane.getByText('● connected')).toBeVisible();
    await expect(pane.getByRole('radio', { name: region })).toBeChecked();
  });
}

test('a connected Connector says the key is set, never shows it, and Reconnect keeps it', async ({ page }) => {
  const connector = newRelic({ status: 'ok', account_label: ACCOUNT }, { account_id: ACCOUNT, region: 'EU' });
  await answerConnect(page, connector);
  const { pane } = await openPane(page, connector, 'Manage');
  const key = pane.getByLabel('API key');
  await expect(pane.getByText('Key set in the Keychain.')).toBeVisible();
  await expect(key).toHaveValue('');
  await expect(key).toHaveAttribute('type', 'password');
  await expect(key).toHaveAttribute('placeholder', 'Set. Type a new one to replace it.');
  await expect(pane.getByRole('radio', { name: 'EU' })).toBeChecked();
  await expect(connectButton(pane)).toBeEnabled();

  const sent = sentConnect(page);
  await connectButton(pane).click();
  const body = (await sent).postDataJSON();
  expect(body).toMatchObject({ account_id: ACCOUNT, region: 'EU' });
  expect(body).not.toHaveProperty('secret');
});

test('typing a new key replaces the stored one and clears the field', async ({ page }) => {
  const connector = newRelic({ status: 'ok', account_label: ACCOUNT }, { account_id: ACCOUNT });
  await answerConnect(page, connector);
  const { pane } = await openPane(page, connector, 'Manage');
  await pane.getByLabel('API key').fill(`${KEY}-2`);
  const sent = sentConnect(page);
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toMatchObject({ secret: `${KEY}-2` });
  await expect(pane.getByLabel('API key')).toHaveValue('');
});

test('after a Disconnect the key reads not set and the account ID stays in the field', async ({ page }) => {
  const connector = newRelic({ status: 'ok', account_label: ACCOUNT }, { account_id: ACCOUNT });
  await page.route('**/api/connectors/new_relic_logs/credentials', (route) => {
    Object.assign(connector, { status: 'off', account_label: null });
    return route.fulfill({ json: { data: connector } });
  });
  const { main, pane } = await openPane(page, connector, 'Manage');
  await pane.getByRole('button', { name: 'Disconnect…' }).click();
  await expect(pane.getByText('removes the key from the Keychain')).toBeVisible();
  await expect(pane.getByText(/Signs out/)).toHaveCount(0);
  await pane.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(main.getByRole('listitem', { name: 'New Relic logs' })).toContainText('○ not connected');

  await main
    .getByRole('listitem', { name: 'New Relic logs' })
    .getByRole('button', { name: 'Connect', exact: true })
    .click();
  await expect(pane.getByText('No key set.')).toBeVisible();
  await expect(pane.getByRole('textbox', { name: 'Account ID' })).toHaveValue(ACCOUNT);
  await expect(connectButton(pane)).toBeDisabled();
});

for (const [name, code, message] of [
  [
    'newrelic missing',
    'tool_missing',
    'newrelic is not installed: install the New Relic CLI with `brew install newrelic-cli`, then Connect again',
  ],
  ['a bad account ID', 'validation_failed', 'account_id: digits only'],
  ['no key on a first Connect', 'validation_failed', 'secret: the API key is needed the first time'],
  ['a refused filter', 'validation_failed', 'filter: a condition such as cluster = prod-1, with no SINCE or LIMIT'],
] as const) {
  test(`a 422 ${code} answer shows its message and leaves the Connector unconnected (${name})`, async ({ page }) => {
    await page.route('**/api/connectors/new_relic_logs/connect', (route) => route.fulfill(error(422, code, message)));
    const { pane } = await openPane(page, newRelic(), 'Connect');
    await pane.getByRole('textbox', { name: 'Account ID' }).fill('abc');
    await pane.getByLabel('API key').fill(KEY);
    await connectButton(pane).click();
    await expect(pane.getByRole('alert')).toHaveText(message);
    await expect(pane.getByText('○ not connected')).toBeVisible();
    await expect(pane.getByRole('textbox', { name: 'Account ID' })).toHaveValue('abc');
  });
}

test('a 422 keeps the typed key in the field so it is not typed twice', async ({ page }) => {
  await page.route('**/api/connectors/new_relic_logs/connect', (route) =>
    route.fulfill(error(422, 'validation_failed', 'account_id: digits only')),
  );
  const { pane } = await openPane(page, newRelic(), 'Connect');
  await pane.getByRole('textbox', { name: 'Account ID' }).fill('abc');
  await pane.getByLabel('API key').fill(KEY);
  await connectButton(pane).click();
  await expect(pane.getByRole('alert')).toContainText('account_id');
  await expect(pane.getByLabel('API key')).toHaveValue(KEY);
});

test('Connect shows checking while the health check runs and cannot be pressed again', async ({ page }) => {
  const { main, pane } = await openPane(
    page,
    newRelic({ status: 'checking', account_label: ACCOUNT }, { account_id: ACCOUNT }),
    'Manage',
  );
  await expect(pane.getByText('◌ checking')).toBeVisible();
  await expect(pane.getByText('Checking New Relic…')).toBeVisible();
  await expect(connectButton(pane)).toBeDisabled();
  await expect(main.getByRole('listitem', { name: 'New Relic logs' })).toContainText('◌ checking');
});

test('a Connector that needs auth shows what to check and Reconnect with the key field, and no Sign in', async ({
  page,
}) => {
  const detail =
    'New Relic refused the key. Check the key, and that a key belongs to one region: choose the region of the account.';
  const { main, pane } = await openPane(
    page,
    newRelic({ status: 'auth', status_detail: detail, account_label: ACCOUNT }, { account_id: ACCOUNT, region: 'EU' }),
    'Reconnect',
  );
  await expect(pane.getByRole('alert')).toHaveText(detail);
  await expect(main.getByRole('listitem', { name: 'New Relic logs' })).toContainText('needs auth');
  await expect(main.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(pane.getByText('Key set in the Keychain.')).toBeVisible();
  await expect(connectButton(pane)).toBeEnabled();
});

test('a Connector that is down shows the reason on the pane and failed on the row', async ({ page }) => {
  const detail = 'Could not reach New Relic: connection refused';
  const { main, pane } = await openPane(
    page,
    newRelic({ status: 'fail', status_detail: detail, account_label: ACCOUNT }, { account_id: ACCOUNT }),
    'Reconnect',
  );
  await expect(pane.getByRole('alert')).toHaveText(detail);
  await expect(main.getByRole('listitem', { name: 'New Relic logs' })).toContainText('✕ failed');
});

test('a Connector down for a missing newrelic names the install command', async ({ page }) => {
  const detail =
    'newrelic is not installed: install the New Relic CLI with `brew install newrelic-cli`, then Connect again';
  const { pane } = await openPane(
    page,
    newRelic({ status: 'fail', status_detail: detail }, { account_id: ACCOUNT }),
    'Reconnect',
  );
  await expect(pane.getByRole('alert')).toHaveText(detail);
});
