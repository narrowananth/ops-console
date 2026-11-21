import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const FOLDER = '/var/log/otel';

const otel = (extra: Record<string, unknown> = {}) => ({
  id: 'otel_logs',
  name: 'OpenTelemetry logs',
  via: 'a local folder',
  status: 'off',
  status_detail: null as string | null,
  account_label: null,
  login: null,
  config: { folder: '' } as Record<string, unknown>,
  last_checked_at: null,
  sign_in: null,
  pick: null,
  ...extra,
});

async function openPane(page: Page, connector: ReturnType<typeof otel>, action: string) {
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [connector], meta: { next_cursor: null } } }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const main = page.getByRole('main');
  await main
    .getByRole('listitem', { name: 'OpenTelemetry logs' })
    .getByRole('button', { name: action, exact: true })
    .click();
  return { main, pane: main.getByRole('complementary', { name: 'Integration' }) };
}

/** The daemon opens the macOS folder dialog; `path` is the folder chosen, or null when the dialog was cancelled. */
async function answerPickFolder(page: Page, path: string | null) {
  await page.route('**/api/connectors/otel_logs/pick-folder', (route) => route.fulfill({ json: { data: { path } } }));
}

const connectButton = (pane: Locator) => pane.getByRole('button', { name: /^(Connect|Reconnect)$/ });

test('OpenTelemetry logs is not connected at first: no path field, Choose folder is offered, and Connect waits for a folder', async ({
  page,
}) => {
  const { main, pane } = await openPane(page, otel(), 'Connect');
  await expect(pane.getByText('Connect OpenTelemetry logs to Ops Console')).toBeVisible();
  await expect(pane.getByText('Reached through a local folder.')).toBeVisible();
  await expect(pane.getByText('○ not connected')).toBeVisible();
  await expect(main.getByRole('listitem', { name: 'OpenTelemetry logs' })).toContainText('○ not connected');
  await expect(pane.getByRole('textbox')).toHaveCount(0);
  await expect(pane.getByText('No folder chosen')).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Choose folder…' })).toBeEnabled();
  await expect(connectButton(pane)).toBeDisabled();
});

test('Choose folder shows the chosen path, and Connect sends it and starts reading', async ({ page }) => {
  const connector = otel();
  await answerPickFolder(page, FOLDER);
  await page.route('**/api/connectors/otel_logs/connect', (route) => {
    Object.assign(connector, { status: 'ok', account_label: FOLDER, config: { folder: FOLDER } });
    return route.fulfill({ status: 202 });
  });
  const { main, pane } = await openPane(page, connector, 'Connect');
  await pane.getByRole('button', { name: 'Choose folder…' }).click();
  const chosen = pane.getByRole('region', { name: 'Log folder' });
  await expect(chosen).toContainText(FOLDER);
  await expect(page.getByRole('main')).not.toContainText('● connected');

  const sent = page.waitForRequest((request) => request.url().endsWith('/api/connectors/otel_logs/connect'));
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toEqual({ folder: FOLDER });

  await expect(pane.getByText('● connected')).toBeVisible();
  await expect(chosen).toContainText(FOLDER);
  await expect(main.getByRole('listitem', { name: 'OpenTelemetry logs' })).toContainText(FOLDER);
});

test('a cancelled folder dialog changes nothing', async ({ page }) => {
  await answerPickFolder(page, null);
  const { pane } = await openPane(page, otel(), 'Connect');
  await pane.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(pane.getByText('No folder chosen')).toBeVisible();
  await expect(connectButton(pane)).toBeDisabled();
});

test('choosing another folder on a connected Connector replaces the shown path, and Reconnect sends it', async ({
  page,
}) => {
  await answerPickFolder(page, '/var/log/other');
  await page.route('**/api/connectors/otel_logs/connect', (route) => route.fulfill({ status: 202 }));
  const { pane } = await openPane(page, otel({ status: 'ok', config: { folder: FOLDER } }), 'Manage');
  await expect(pane.getByRole('region', { name: 'Log folder' })).toContainText(FOLDER);
  await pane.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(pane.getByRole('region', { name: 'Log folder' })).toContainText('/var/log/other');
  const sent = page.waitForRequest((request) => request.url().endsWith('/api/connectors/otel_logs/connect'));
  await connectButton(pane).click();
  expect((await sent).postDataJSON()).toEqual({ folder: '/var/log/other' });
});

test('a folder dialog that fails shows the reason', async ({ page }) => {
  await page.route('**/api/connectors/otel_logs/pick-folder', (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'The folder dialog did not open' } } }),
  );
  const { pane } = await openPane(page, otel(), 'Connect');
  await pane.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(pane.getByRole('alert')).toHaveText('The folder dialog did not open');
});

test('a Log folder the console cannot read shows the reason on the pane and failed on the row', async ({ page }) => {
  const { main, pane } = await openPane(
    page,
    otel({ status: 'fail', status_detail: 'Folder not found', config: { folder: FOLDER } }),
    'Reconnect',
  );
  await expect(pane.getByRole('region', { name: 'Log folder' })).toContainText(FOLDER);
  await expect(pane.getByRole('alert')).toHaveText('Folder not found');
  await expect(main.getByRole('listitem', { name: 'OpenTelemetry logs' })).toContainText('✕ failed');
});

test('a folder the daemon refuses with 422 shows its reason and leaves the Connector unconnected', async ({ page }) => {
  await answerPickFolder(page, '/root/private');
  await page.route('**/api/connectors/otel_logs/connect', (route) =>
    route.fulfill({
      status: 422,
      json: { error: { code: 'folder_not_found', message: 'Folder not readable' } },
    }),
  );
  const { pane } = await openPane(page, otel(), 'Connect');
  await pane.getByRole('button', { name: 'Choose folder…' }).click();
  await connectButton(pane).click();
  await expect(pane.getByRole('alert')).toHaveText('Folder not readable');
  await expect(pane.getByText('○ not connected')).toBeVisible();
});

test('a Connector being checked shows checking and cannot be connected again', async ({ page }) => {
  const { pane } = await openPane(page, otel({ status: 'checking', config: { folder: FOLDER } }), 'Manage');
  await expect(pane.getByText('◌ checking')).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Reconnect', exact: true })).toBeDisabled();
});

test('disconnecting OpenTelemetry logs says the folder stays', async ({ page }) => {
  const connector = otel({ status: 'ok', config: { folder: FOLDER } });
  await page.route('**/api/connectors/otel_logs/credentials', (route) => {
    Object.assign(connector, { status: 'off' });
    return route.fulfill({ json: { data: connector } });
  });
  const { main, pane } = await openPane(page, connector, 'Manage');
  await pane.getByRole('button', { name: 'Disconnect…' }).click();
  await expect(pane.getByText('The folder and its files stay as they are.')).toBeVisible();
  await expect(pane.getByText(/Signs out/)).toHaveCount(0);
  await pane.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(main.getByRole('listitem', { name: 'OpenTelemetry logs' })).toContainText('○ not connected');
});
