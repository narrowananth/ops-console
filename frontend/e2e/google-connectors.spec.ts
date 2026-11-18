import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

const google = (id: string, name: string) => ({
  id,
  name,
  via: `${name} MCP`,
  status: 'off',
  status_detail: null as string | null,
  account_label: null,
  login: null,
  config: {},
  last_checked_at: null,
  sign_in: null,
});

test('a Google Connector connects in one step, with nothing to fill in', async ({ page }) => {
  const drive = google('google_drive', 'Google Drive');
  const calls: string[] = [];
  await page.route('**/api/connectors', (route) =>
    route.fulfill({
      json: {
        data: [google('google_docs', 'Google Docs'), google('google_sheets', 'Google Sheets'), drive],
        meta: { next_cursor: null },
      },
    }),
  );
  await page.route('**/api/connectors/google_drive/connect', (route) => {
    calls.push('connect');
    Object.assign(drive, { status: 'ok' });
    return route.fulfill({ status: 202 });
  });
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const main = page.getByRole('main');
  const list = main.getByRole('list', { name: 'Integrations' });
  for (const name of ['Google Docs', 'Google Sheets', 'Google Drive']) {
    await expect(list.getByRole('listitem', { name })).toContainText('Connector');
  }

  await list
    .getByRole('listitem', { name: 'Google Drive' })
    .getByRole('button', { name: 'Connect', exact: true })
    .click();
  await expect(main.getByText('Connect Google Drive to Ops Console')).toBeVisible();
  await expect(main.getByText('Reached through Google Drive MCP.')).toBeVisible();
  await expect(main.getByRole('textbox')).toHaveCount(0);
  const step = main.getByRole('region', { name: 'Sign in' });
  await expect(step).toContainText("Opens Google Drive's sign-in page in your browser. Nothing to fill in here.");
  await step.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(step.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  expect(calls).toEqual(['connect']);
});

test('a Google build with no client shows why under the step', async ({ page }) => {
  const docs = {
    ...google('google_docs', 'Google Docs'),
    status: 'auth',
    status_detail: 'Google sign-in is not set up in this build',
  };
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [docs], meta: { next_cursor: null } } }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const main = page.getByRole('main');
  await main.getByRole('listitem', { name: 'Google Docs' }).getByRole('button', { name: 'Sign in' }).click();
  await expect(main.getByRole('region', { name: 'Sign in' }).getByRole('alert')).toContainText(
    'Google sign-in is not set up in this build',
  );
});
