import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));

type Row = {
  id: string;
  name: string;
  via: string;
  status: string;
  status_detail: string | null;
  account_label: null;
  login: null;
  config: { client_id: string };
  last_checked_at: null;
  sign_in: null;
};

const google = (id: string, name: string): Row => ({
  id,
  name,
  via: `${name} MCP`,
  status: 'off',
  status_detail: null,
  account_label: null,
  login: null,
  config: { client_id: '' },
  last_checked_at: null,
  sign_in: null,
});

test('Google panes walk through the client, the APIs and the sign-in, and share one saved client', async ({ page }) => {
  const rows = [
    google('google_docs', 'Google Docs'),
    google('google_sheets', 'Google Sheets'),
    google('google_drive', 'Google Drive'),
  ];
  const saved: unknown[] = [];
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: rows, meta: { next_cursor: null } } }),
  );
  await page.route('**/api/connectors/google/client', (route) => {
    saved.push(route.request().postDataJSON());
    for (const row of rows) row.config = { client_id: route.request().postDataJSON().client_id };
    return route.fulfill({ json: { data: rows, meta: { next_cursor: null } } });
  });
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const main = page.getByRole('main');
  const list = main.getByRole('list', { name: 'Integrations' });
  for (const name of ['Google Docs', 'Google Sheets', 'Google Drive']) {
    await expect(list.getByRole('listitem', { name })).toContainText('Connector');
  }

  await list
    .getByRole('listitem', { name: 'Google Sheets' })
    .getByRole('button', { name: 'Connect', exact: true })
    .click();
  await expect(main.getByText('Connect Google Sheets to Ops Console')).toBeVisible();
  await expect(main.getByRole('region', { name: 'Create an OAuth client' })).toContainText(
    'http://localhost:3119/callback',
  );
  const apis = main.getByRole('region', { name: 'Enable the APIs' });
  await expect(apis).toContainText('sheets.googleapis.com');
  await expect(apis).toContainText('sheetsmcp.googleapis.com');

  // Connect waits for the client.
  const connect = main.getByRole('region', { name: 'Sign in' });
  await expect(connect).toContainText('Save the client first');
  await expect(connect.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();

  const form = main.getByRole('region', { name: 'Enter the client' });
  await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
  await form.getByRole('textbox', { name: 'Client ID' }).fill('client-1.apps.example.com');
  await form.getByLabel('Client secret').fill('GOCSPX-example-secret');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toContainText('Client saved.');
  await expect(form.getByLabel('Client secret')).toHaveCount(0);
  expect(saved).toEqual([{ client_id: 'client-1.apps.example.com', client_secret: 'GOCSPX-example-secret' }]);
  await expect(connect.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
  await expect(connect).not.toContainText('Save the client first');

  // The other two panes read the client as saved too.
  await main.getByRole('button', { name: 'Close', exact: true }).click();
  await list
    .getByRole('listitem', { name: 'Google Drive' })
    .getByRole('button', { name: 'Connect', exact: true })
    .click();
  await expect(main.getByRole('region', { name: 'Enter the client' })).toContainText('Client saved.');
  await expect(main.getByRole('region', { name: 'Enable the APIs' })).toContainText('drivemcp.googleapis.com');

  // The last Disconnect clears the client, and the form comes back.
  for (const row of rows) row.config = { client_id: '' };
  await page.reload();
  await list
    .getByRole('listitem', { name: 'Google Drive' })
    .getByRole('button', { name: 'Connect', exact: true })
    .click();
  await expect(main.getByRole('region', { name: 'Enter the client' }).getByLabel('Client secret')).toBeVisible();
});

test('a refused client save shows its reason under the step', async ({ page }) => {
  const docs = { ...google('google_docs', 'Google Docs'), status: 'ok' };
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [docs], meta: { next_cursor: null } } }),
  );
  await page.route('**/api/connectors/google/client', (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: 'google_client_in_use',
          message: 'Google Docs is connected: Disconnect the Google Connectors first',
        },
      },
    }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const main = page.getByRole('main');
  await main.getByRole('listitem', { name: 'Google Docs' }).getByRole('button', { name: 'Manage' }).click();
  const form = main.getByRole('region', { name: 'Enter the client' });
  await form.getByRole('textbox', { name: 'Client ID' }).fill('other.apps.example.com');
  await form.getByLabel('Client secret').fill('GOCSPX-other');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('alert')).toContainText('Disconnect the Google Connectors first');
});
