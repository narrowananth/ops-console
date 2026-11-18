import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const PAGE = 'https://claude.ai/new#customize/connectors';

const google = (id: string, name: string) => ({
  id,
  name,
  via: `claude.ai ${name}`,
  status: 'off',
  status_detail: null as string | null,
  account_label: null,
  login: null,
  config: {},
  last_checked_at: null,
  sign_in: null as { code: string | null; url: string | null } | null,
});

test('a Google Connector sends the operator to claude.ai, waits, and connects when the connector is added', async ({
  page,
}) => {
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
  await expect(main.getByText('Reached through claude.ai Google Drive.')).toBeVisible();
  await expect(main.getByRole('textbox')).toHaveCount(0);
  const step = main.getByRole('region', { name: 'Sign in' });
  await expect(step).toContainText('Opens claude.ai in your browser. Add Google Drive there, with Connect.');
  await step.getByRole('button', { name: 'Connect', exact: true }).click();

  await expect(step).toContainText('Finish in the browser tab that opened.');
  await expect(step.getByRole('link', { name: 'Open Google Drive ↗' })).toHaveAttribute('href', PAGE);
  await expect(step.getByRole('button', { name: 'Waiting…' })).toBeDisabled();
  await step.getByRole('button', { name: 'Cancel' }).click();
  await expect(step.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
});

test('a Google Connector not added on claude.ai says so under the step, and Disconnect says it stays there', async ({
  page,
}) => {
  const docs = {
    ...google('google_docs', 'Google Docs'),
    status: 'auth',
    status_detail: 'Google Docs is not added on claude.ai. Add it there, with an account signed in through claude.ai',
  };
  await page.route('**/api/connectors', (route) =>
    route.fulfill({ json: { data: [docs], meta: { next_cursor: null } } }),
  );
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Integrations' }).click();
  const main = page.getByRole('main');
  await main.getByRole('listitem', { name: 'Google Docs' }).getByRole('button', { name: 'Sign in' }).click();
  await expect(main.getByRole('region', { name: 'Sign in' }).getByRole('alert')).toContainText(
    'is not added on claude.ai',
  );
  await main.getByRole('button', { name: 'Disconnect…' }).click();
  await expect(main.getByText('It stays added on claude.ai')).toBeVisible();
});
