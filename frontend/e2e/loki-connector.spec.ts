import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const LOKI_URL = 'https://loki.example.com';
const TOKEN = 'glc_fake-token-for-tests';

const CONFIG = {
  url: '',
  org_id: '',
  auth: 'none',
  username: '',
  service_label: 'service_name',
  env_label: 'deployment_environment_name',
  selector: '',
  format: 'json',
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
  via: 'logcli CLI',
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

/** A connect answer that stores what the body says, as the daemon does, and never sends the secret back. */
async function answerConnect(page: Page, connector: ReturnType<typeof loki>, status = 'ok') {
  await page.route('**/api/connectors/loki_logs/connect', (route) => {
    const { secret: _secret, ...fields } = route.request().postDataJSON();
    Object.assign(connector, {
      status,
      account_label: fields.url,
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
  page.waitForRequest((request) => request.url().endsWith('/api/connectors/loki_logs/connect'));

test('Loki logs is not connected at first: the pane has the fields with their defaults and Connect waits for a URL', async ({
  page,
}) => {
  const { main, pane } = await openPane(page, loki(), 'Connect');
  await expect(pane.getByText('Connect Loki logs to Ops Console')).toBeVisible();
  await expect(pane.getByText('Reached through logcli CLI.')).toBeVisible();
  await expect(pane.getByText('○ not connected')).toBeVisible();
  await expect(main.getByRole('listitem', { name: 'Loki logs' })).toContainText('○ not connected');

  await expect(pane.getByRole('textbox', { name: 'Loki URL' })).toHaveValue('');
  await expect(pane.getByRole('textbox', { name: 'Org ID' })).toHaveValue('');
  await expect(pane.getByRole('radio', { name: 'None' })).toBeChecked();
  await expect(pane.getByRole('textbox', { name: 'Service label' })).toHaveValue('service_name');
  await expect(pane.getByRole('textbox', { name: 'Env label' })).toHaveValue('deployment_environment_name');
  await expect(pane.getByRole('textbox', { name: 'Stream selector' })).toHaveValue('');
  await expect(pane.getByRole('radio', { name: 'JSON' })).toBeChecked();
  await expect(pane.getByRole('radio', { name: 'logfmt' })).not.toBeChecked();
  await expect(pane.getByRole('region', { name: 'Sign in' })).toHaveCount(0);

  await expect(pane.getByRole('textbox', { name: 'Username' })).toHaveCount(0);
  await expect(pane.getByLabel('Secret')).toHaveCount(0);
  await expect(pane.getByText(/Grafana Cloud/)).toContainText('logs:read');

  await expect(connectButton(pane)).toBeDisabled();
  await pane.getByRole('textbox', { name: 'Loki URL' }).fill(LOKI_URL);
  await expect(connectButton(pane)).toBeEnabled();
});

test('the label fields show their default names in full', async ({ page }) => {
  const { pane } = await openPane(page, loki(), 'Connect');
  for (const name of ['Service label', 'Env label']) {
    const field = pane.getByRole('textbox', { name });
    const clipped = await field.evaluate((input: HTMLInputElement) => input.scrollWidth > input.clientWidth);
    expect(clipped, name).toBe(false);
  }
});

test('connecting with no auth sends the fields and no secret, then shows connected with the URL', async ({ page }) => {
  const connector = loki();
  await answerConnect(page, connector);
  const { main, pane } = await openPane(page, connector, 'Connect');
  await pane.getByRole('textbox', { name: 'Loki URL' }).fill(` ${LOKI_URL} `);
  await pane.getByRole('textbox', { name: 'Stream selector' }).fill('cluster="prod-1"');
  await pick(pane, 'logfmt');

  const sent = sentConnect(page);
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toEqual({
    url: LOKI_URL,
    org_id: '',
    auth: 'none',
    username: '',
    service_label: 'service_name',
    env_label: 'deployment_environment_name',
    selector: 'cluster="prod-1"',
    format: 'logfmt',
  });

  await expect(pane.getByText('● connected')).toBeVisible();
  await expect(pane.getByText(`Reading logs from ${LOKI_URL}.`)).toBeVisible();
  await expect(main.getByRole('listitem', { name: 'Loki logs' })).toContainText(`logcli CLI · ${LOKI_URL}`);
  await expect(pane.getByRole('textbox', { name: 'Stream selector' })).toHaveValue('cluster="prod-1"');
  await expect(pane.getByRole('radio', { name: 'logfmt' })).toBeChecked();
});

test('bearer asks for a secret and no username, and sends the secret only once', async ({ page }) => {
  const connector = loki();
  await answerConnect(page, connector);
  const { pane } = await openPane(page, connector, 'Connect');
  await pane.getByRole('textbox', { name: 'Loki URL' }).fill(LOKI_URL);
  await pane.getByRole('textbox', { name: 'Org ID' }).fill('tenant-1');
  await pick(pane, 'Bearer token');

  await expect(pane.getByRole('textbox', { name: 'Username' })).toHaveCount(0);
  const secret = pane.getByLabel('Secret');
  await expect(secret).toHaveAttribute('type', 'password');
  await expect(pane.getByText('No secret set.')).toBeVisible();
  await expect(connectButton(pane)).toBeDisabled();

  await secret.fill(TOKEN);
  await expect(connectButton(pane)).toBeEnabled();
  const sent = sentConnect(page);
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toEqual({
    url: LOKI_URL,
    org_id: 'tenant-1',
    auth: 'bearer',
    username: '',
    service_label: 'service_name',
    env_label: 'deployment_environment_name',
    selector: '',
    format: 'json',
    secret: TOKEN,
  });

  await expect(pane.getByText('● connected')).toBeVisible();
  await expect(pane.getByText('Secret set in the Keychain.')).toBeVisible();
  await expect(secret).toHaveValue('');
  await expect(page.getByRole('main')).not.toContainText(TOKEN);
});

test('basic asks for a username and a secret, and Grafana Cloud values connect', async ({ page }) => {
  const connector = loki();
  await answerConnect(page, connector);
  const { pane } = await openPane(page, connector, 'Connect');
  await pane.getByRole('textbox', { name: 'Loki URL' }).fill('https://logs-prod-000.grafana.net');
  await pick(pane, 'Basic');

  const username = pane.getByRole('textbox', { name: 'Username' });
  await expect(username).toBeVisible();
  await expect(pane.getByLabel('Secret')).toBeVisible();
  await expect(connectButton(pane)).toBeDisabled();
  await username.fill('123456');
  await expect(connectButton(pane)).toBeDisabled();
  await pane.getByLabel('Secret').fill(TOKEN);
  await expect(connectButton(pane)).toBeEnabled();

  const sent = sentConnect(page);
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toMatchObject({
    url: 'https://logs-prod-000.grafana.net',
    auth: 'basic',
    username: '123456',
    secret: TOKEN,
  });
  await expect(pane.getByText('● connected')).toBeVisible();
  await expect(pane.getByRole('textbox', { name: 'Username' })).toHaveValue('123456');
});

test('going back to no auth clears the username in the body and hides the secret field', async ({ page }) => {
  const connector = loki(
    { status: 'ok', account_label: LOKI_URL },
    { url: LOKI_URL, auth: 'basic', username: '123456' },
  );
  await answerConnect(page, connector);
  const { pane } = await openPane(page, connector, 'Manage');
  await expect(pane.getByRole('textbox', { name: 'Username' })).toHaveValue('123456');
  await pick(pane, 'None');
  await expect(pane.getByLabel('Secret')).toHaveCount(0);
  await expect(pane.getByRole('textbox', { name: 'Username' })).toHaveCount(0);
  const sent = sentConnect(page);
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toMatchObject({ auth: 'none', username: '' });
});

test('a connected Connector with a secret says it is set, never shows it, and Reconnect keeps it', async ({ page }) => {
  const connector = loki({ status: 'ok', account_label: LOKI_URL }, { url: LOKI_URL, auth: 'bearer' });
  await answerConnect(page, connector);
  const { pane } = await openPane(page, connector, 'Manage');
  const secret = pane.getByLabel('Secret');
  await expect(pane.getByText('Secret set in the Keychain.')).toBeVisible();
  await expect(secret).toHaveValue('');
  await expect(secret).toHaveAttribute('placeholder', 'Set. Type a new one to replace it.');
  await expect(connectButton(pane)).toBeEnabled();

  const sent = sentConnect(page);
  await connectButton(pane).click();
  const body = (await sent).postDataJSON();
  expect(body).toMatchObject({ url: LOKI_URL, auth: 'bearer' });
  expect(body).not.toHaveProperty('secret');
});

test('typing a new secret replaces the stored one', async ({ page }) => {
  const connector = loki({ status: 'ok', account_label: LOKI_URL }, { url: LOKI_URL, auth: 'bearer' });
  await answerConnect(page, connector);
  const { pane } = await openPane(page, connector, 'Manage');
  await pane.getByLabel('Secret').fill(`${TOKEN}-2`);
  const sent = sentConnect(page);
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toMatchObject({ secret: `${TOKEN}-2` });
  await expect(pane.getByLabel('Secret')).toHaveValue('');
});

test('after a Disconnect the secret reads not set and the URL stays in the field', async ({ page }) => {
  const connector = loki({ status: 'ok', account_label: LOKI_URL }, { url: LOKI_URL, auth: 'bearer' });
  await page.route('**/api/connectors/loki_logs/credentials', (route) => {
    Object.assign(connector, { status: 'off', account_label: null });
    return route.fulfill({ json: { data: connector } });
  });
  const { main, pane } = await openPane(page, connector, 'Manage');
  await pane.getByRole('button', { name: 'Disconnect…' }).click();
  await expect(pane.getByText('removes the secret from the Keychain')).toBeVisible();
  await expect(pane.getByText(/Signs out/)).toHaveCount(0);
  await pane.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(main.getByRole('listitem', { name: 'Loki logs' })).toContainText('○ not connected');

  await main.getByRole('listitem', { name: 'Loki logs' }).getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(pane.getByText('No secret set.')).toBeVisible();
  await expect(pane.getByRole('textbox', { name: 'Loki URL' })).toHaveValue(LOKI_URL);
  await expect(connectButton(pane)).toBeDisabled();
});

for (const [name, code, message] of [
  [
    'logcli missing',
    'tool_missing',
    'logcli is not installed: install it with `brew install logcli`, then Connect again',
  ],
  ['a URL with credentials', 'validation_failed', 'url: credentials belong in the secret field, not the URL'],
  ['a bad selector', 'validation_failed', 'selector: stream matchers such as cluster="prod-1"'],
] as const) {
  test(`a 422 ${code} answer shows its message and leaves the Connector unconnected (${name})`, async ({ page }) => {
    await page.route('**/api/connectors/loki_logs/connect', (route) => route.fulfill(error(422, code, message)));
    const { pane } = await openPane(page, loki(), 'Connect');
    await pane.getByRole('textbox', { name: 'Loki URL' }).fill(LOKI_URL);
    await connectButton(pane).click();
    await expect(pane.getByRole('alert')).toHaveText(message);
    await expect(pane.getByText('○ not connected')).toBeVisible();
    await expect(pane.getByRole('textbox', { name: 'Loki URL' })).toHaveValue(LOKI_URL);
  });
}

test('a 422 keeps the typed secret in the field so it is not typed twice', async ({ page }) => {
  await page.route('**/api/connectors/loki_logs/connect', (route) =>
    route.fulfill(error(422, 'validation_failed', 'service_label: a label name: letters, digits and _')),
  );
  const { pane } = await openPane(page, loki(), 'Connect');
  await pane.getByRole('textbox', { name: 'Loki URL' }).fill(LOKI_URL);
  await pick(pane, 'Bearer token');
  await pane.getByLabel('Secret').fill(TOKEN);
  await connectButton(pane).click();
  await expect(pane.getByRole('alert')).toContainText('service_label');
  await expect(pane.getByLabel('Secret')).toHaveValue(TOKEN);
});

test('Connect shows checking while the health check runs and cannot be pressed again', async ({ page }) => {
  const { main, pane } = await openPane(
    page,
    loki({ status: 'checking', account_label: LOKI_URL }, { url: LOKI_URL, auth: 'none' }),
    'Manage',
  );
  await expect(pane.getByText('◌ checking')).toBeVisible();
  await expect(pane.getByText('Checking Loki…')).toBeVisible();
  await expect(connectButton(pane)).toBeDisabled();
  await expect(main.getByRole('listitem', { name: 'Loki logs' })).toContainText('◌ checking');
});

test('a Connector that needs auth shows what to check and Reconnect with the secret field, and no Sign in', async ({
  page,
}) => {
  const detail =
    'Loki refused the secret. Check the secret, and for Grafana Cloud that the access-policy token has the `logs:read` scope.';
  const { main, pane } = await openPane(
    page,
    loki(
      { status: 'auth', status_detail: detail, account_label: LOKI_URL },
      { url: LOKI_URL, auth: 'basic', username: '1' },
    ),
    'Reconnect',
  );
  await expect(pane.getByRole('alert')).toHaveText(detail);
  await expect(main.getByRole('listitem', { name: 'Loki logs' })).toContainText('needs auth');
  await expect(main.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(pane.getByText('Secret set in the Keychain.')).toBeVisible();
  await expect(connectButton(pane)).toBeEnabled();
});

test('a Connector that is down shows the reason on the pane and failed on the row', async ({ page }) => {
  const detail = `Could not reach ${LOKI_URL}: connection refused`;
  const { main, pane } = await openPane(
    page,
    loki({ status: 'fail', status_detail: detail, account_label: LOKI_URL }, { url: LOKI_URL }),
    'Reconnect',
  );
  await expect(pane.getByRole('alert')).toHaveText(detail);
  await expect(main.getByRole('listitem', { name: 'Loki logs' })).toContainText('✕ failed');
});

test('a Connector down for a missing logcli names the install command', async ({ page }) => {
  const detail = 'logcli is not installed: install it with `brew install logcli`, then Connect again';
  const { pane } = await openPane(
    page,
    loki({ status: 'fail', status_detail: detail }, { url: LOKI_URL }),
    'Reconnect',
  );
  await expect(pane.getByRole('alert')).toHaveText(detail);
});
