import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-04T09:00:00.000Z';

const REPO = {
  id: 'r1',
  name: 'checkout-api',
  path: '/work/checkout-api',
  host: 'bitbucket',
  remote_slug: 'example/checkout-api',
  default_branch: 'main',
  created_at: NOW,
  branch: 'fix/empty-cart',
  dirty: false,
  missing: false,
  session_count: 1,
};

const SESSION = {
  id: 's1',
  kind: 'repo',
  title: 'Fix the empty cart',
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'auto',
  account_id: null,
  repo_id: 'r1',
  branch: 'fix/empty-cart',
  pr_number: null,
  connection_ids: null,
  alert_id: null,
  state: 'idle',
  last_message_preview: null,
  last_error: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook: null,
  queued_message: null,
};

type Status = { can_open: boolean; uncommitted_files?: number };

/** One Session on a branch with no pull request. The daemon's answers for opening one are scripted per test. */
async function route(page: Page, status: Status) {
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: [REPO], meta: { next_cursor: null } } }));
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => route.fulfill({ json: { data: [SESSION] } }));
  await page.route('**/api/sessions/s1/messages', (route) => route.fulfill({ json: { data: [] } }));
  await page.route(/\/api\/pull-requests\?/, (route) =>
    route.fulfill({ json: { data: [], meta: { synced_at: NOW, stale: false, next_cursor: null } } }),
  );
  await page.route('**/api/sessions/s1/diff', (route) =>
    route.fulfill({
      json: { data: { branch: 'fix/empty-cart', base: 'main', files: [], additions: 0, deletions: 0 } },
    }),
  );
  await page.route('**/api/sessions/s1/pull-request', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      json: { data: { pull_request: null, base_branch: 'main', uncommitted_files: 0, ...status } },
    });
  });
}

const open = (page: Page) => page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

test('the agent drafts the text, the operator edits it, and confirming has the console open the pull request', async ({
  page,
}) => {
  await route(page, { can_open: true, uncommitted_files: 2 });
  const opened: unknown[] = [];
  await page.route('**/api/sessions/s1/pull-request-draft', (route) =>
    route.fulfill({
      json: { data: { title: 'Guard the empty cart', description: 'Checkout threw on an empty cart.' } },
    }),
  );
  await page.route('**/api/sessions/s1/pull-request', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    opened.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      json: { data: { number: 12, url: 'https://bitbucket.org/example/checkout-api/pull-requests/12' } },
    });
  });
  await open(page);

  await page.getByRole('button', { name: 'Open pull request' }).click();
  const form = page.getByRole('form', { name: 'Open pull request' });
  await expect(form.getByLabel('Title')).toHaveValue('Guard the empty cart');
  await expect(form.getByLabel('Description')).toHaveValue('Checkout threw on an empty cart.');
  await expect(form.getByLabel('Base branch')).toHaveValue('main');
  await expect(form).toContainText('2 files have changes that are not committed. The pull request leaves them out.');

  await form.getByLabel('Title').fill('Guard empty carts at checkout');
  await form.getByLabel('Base branch').fill('release');
  await form.getByRole('button', { name: 'Open pull request' }).click();
  await expect(form).toHaveCount(0);
  expect(opened).toEqual([
    { title: 'Guard empty carts at checkout', description: 'Checkout threw on an empty cart.', base_branch: 'release' },
  ]);
});

test('a draft that failed leaves the fields empty to write by hand, and Open stays off until there is a title', async ({
  page,
}) => {
  await route(page, { can_open: true });
  await page.route('**/api/sessions/s1/pull-request-draft', (route) =>
    route.fulfill({ json: { data: { title: null, description: null } } }),
  );
  await open(page);

  await page.getByRole('button', { name: 'Open pull request' }).click();
  const form = page.getByRole('form', { name: 'Open pull request' });
  await expect(form.getByLabel('Title')).toHaveValue('');
  await expect(form.getByLabel('Title')).toBeEditable();
  await expect(form.getByRole('button', { name: 'Open pull request' })).toBeDisabled();
  await form.getByLabel('Title').fill('Guard empty carts');
  await expect(form.getByRole('button', { name: 'Open pull request' })).toBeEnabled();
});

test('a Git host that is not connected shows why under the form and links Integrations, and keeps the text', async ({
  page,
}) => {
  await route(page, { can_open: true });
  await page.route('**/api/sessions/s1/pull-request-draft', (route) =>
    route.fulfill({ json: { data: { title: 'Guard empty carts', description: 'Body' } } }),
  );
  await page.route('**/api/sessions/s1/pull-request', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({
      status: 409,
      json: { error: { code: 'connector_not_connected', message: 'Bitbucket is not connected' } },
    });
  });
  await open(page);

  await page.getByRole('button', { name: 'Open pull request' }).click();
  const form = page.getByRole('form', { name: 'Open pull request' });
  await form.getByRole('button', { name: 'Open pull request' }).click();
  await expect(form.getByRole('alert')).toContainText('Bitbucket is not connected');
  await expect(form.getByRole('link', { name: 'Connect it in Integrations' })).toHaveAttribute('href', '/integrations');
  await expect(form.getByLabel('Title')).toHaveValue('Guard empty carts');
});

test('a branch that cannot open a pull request shows no button', async ({ page }) => {
  await route(page, { can_open: false });
  await open(page);
  await expect(page.getByRole('heading', { name: 'Fix the empty cart' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open pull request' })).toHaveCount(0);
});
