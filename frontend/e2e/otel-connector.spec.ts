import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
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

test('connecting OpenTelemetry logs sends the typed Log folder, with no sign-in step', async ({ page }) => {
  const connector = otel();
  await page.route('**/api/connectors/otel_logs/connect', (route) => {
    Object.assign(connector, { status: 'ok', config: { folder: FOLDER } });
    return route.fulfill({ status: 202 });
  });
  const { main, pane } = await openPane(page, connector, 'Connect');
  await expect(pane.getByText('Connect OpenTelemetry logs to Ops Console')).toBeVisible();
  await expect(pane.getByText('Reached through a local folder.')).toBeVisible();
  await expect(pane.getByRole('region', { name: 'Sign in' })).toHaveCount(0);

  const field = pane.getByRole('textbox', { name: 'Log folder' });
  const connect = pane.getByRole('button', { name: 'Connect', exact: true });
  await expect(connect).toBeDisabled();
  await field.fill(FOLDER);
  const sent = page.waitForRequest((request) => request.url().endsWith('/api/connectors/otel_logs/connect'));
  await connect.click();
  expect((await sent).postDataJSON()).toEqual({ folder: FOLDER });

  await expect(pane.getByText('● connected')).toBeVisible();
  await expect(field).toHaveValue(FOLDER);
  await expect(main.getByRole('listitem', { name: 'OpenTelemetry logs' })).toContainText(FOLDER);
});

test('a Log folder the console cannot read shows the reason on the pane and failed on the row', async ({ page }) => {
  const { main, pane } = await openPane(
    page,
    otel({ status: 'fail', status_detail: 'Folder not found', config: { folder: FOLDER } }),
    'Reconnect',
  );
  await expect(pane.getByRole('textbox', { name: 'Log folder' })).toHaveValue(FOLDER);
  await expect(pane.getByRole('region', { name: 'Log folder' }).getByRole('alert')).toHaveText('Folder not found');
  await expect(main.getByRole('listitem', { name: 'OpenTelemetry logs' })).toContainText('✕ failed');
});

test('a folder the daemon refuses with 422 shows its reason and leaves the Connector unconnected', async ({ page }) => {
  await page.route('**/api/connectors/otel_logs/connect', (route) =>
    route.fulfill({
      status: 422,
      json: { error: { code: 'folder_not_found', message: 'Folder not readable' } },
    }),
  );
  const { pane } = await openPane(page, otel(), 'Connect');
  await pane.getByRole('textbox', { name: 'Log folder' }).fill('/root/private');
  await pane.getByRole('button', { name: 'Connect', exact: true }).click();
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
