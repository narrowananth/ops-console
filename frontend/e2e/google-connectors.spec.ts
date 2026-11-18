import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const PAGE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=example';

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
  sign_in: null as { code: string | null; url: string | null } | null,
});

test("a Google Connector opens Google's sign-in, waits, and Cancel stops the wait", async ({ page }) => {
  const drive = google('google_drive', 'Google Drive');
  await page.route('**/api/connectors', (route) =>
    route.fulfill({
      json: {
        data: [google('google_docs', 'Google Docs'), google('google_sheets', 'Google Sheets'), drive],
        meta: { next_cursor: null },
      },
    }),
  );
  await page.route('**/api/connectors/google_drive/connect', (route) => {
    drive.sign_in = { code: null, url: PAGE };
    return route.fulfill({ status: 202 });
  });
  await page.route('**/api/connectors/google_drive/sign-in', (route) => {
    drive.sign_in = null;
    return route.fulfill({ json: { data: drive } });
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
  await expect(step).toContainText(
    'Opens Google in your browser. Pick the Google account to use; every Claude account uses it.',
  );
  await step.getByRole('button', { name: 'Connect', exact: true }).click();

  await expect(step).toContainText('Finish in the browser tab that opened.');
  await expect(step.getByRole('link', { name: 'Open Google ↗' })).toHaveAttribute('href', PAGE);
  await expect(step.getByRole('button', { name: 'Waiting…' })).toBeDisabled();
  await step.getByRole('button', { name: 'Cancel' }).click();
  await expect(step.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
});

test('a connected Google Connector shows the Google account, and one that needs signing in again says so', async ({
  page,
}) => {
  const docs = {
    ...google('google_docs', 'Google Docs'),
    status: 'ok',
    account_label: 'ops@example.com',
    login: 'ops@example.com',
  };
  const sheets = {
    ...google('google_sheets', 'Google Sheets'),
    status: 'auth',
    status_detail: 'Google Sheets needs signing in again',
  };
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [docs, sheets], meta: { next_cursor: null } } }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const main = page.getByRole('main');
  await main.getByRole('listitem', { name: 'Google Docs' }).getByRole('button', { name: 'Manage' }).click();
  await expect(main.getByRole('region', { name: 'Sign in' })).toContainText('Signed in as ops@example.com');
  await main.getByRole('button', { name: 'Disconnect…' }).click();
  await expect(main.getByText('takes its access back at Google')).toBeVisible();

  await main.getByRole('listitem', { name: 'Google Sheets' }).getByRole('button', { name: 'Sign in' }).click();
  await expect(main.getByRole('region', { name: 'Sign in' }).getByRole('alert')).toContainText(
    'needs signing in again',
  );
});
