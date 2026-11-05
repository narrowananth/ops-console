import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-01T09:00:00.000Z';

const repo = (name: string) => ({
  id: `id-${name}`,
  name,
  path: `/Users/operator/code/${name}`,
  host: 'github',
  remote_slug: `acme/${name}`,
  default_branch: 'main',
  created_at: NOW,
  branch: 'main',
  dirty: false,
  missing: false,
  session_count: 0,
});

// The folder dialog and the import are fakes here, so the page answers with fixtures.

test('Local folder imports every folder picked in the dialog, and names the one the console refused', async ({
  page,
}) => {
  const imported: string[] = [];
  await page.route('**/api/repos/pick-folder', (route) =>
    route.fulfill({
      json: {
        data: {
          paths: ['/Users/operator/code/orders-api', '/Users/operator/code/notes', '/Users/operator/code/billing-api'],
        },
      },
    }),
  );
  await page.route('**/api/repos', (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { data: imported.map(repo) } });
    const { path } = route.request().postDataJSON() as { path: string };
    const name = path.split('/').at(-1) ?? '';
    if (name === 'notes') {
      return route.fulfill({
        status: 422,
        json: { error: { code: 'validation_failed', message: 'not a git repository' } },
      });
    }
    imported.push(name);
    return route.fulfill({ status: 201, json: { data: repo(name) } });
  });
  await page.goto(`${daemon.url}/repos#token=${daemon.token}`);

  await page.getByRole('button', { name: /Local folder/ }).click();
  await expect(page.getByRole('status')).toHaveText('Imported orders-api · branch main, billing-api · branch main');
  await expect(page.getByRole('alert')).toHaveText('/Users/operator/code/notes: not a git repository');
  expect(imported).toEqual(['orders-api', 'billing-api']);
});
