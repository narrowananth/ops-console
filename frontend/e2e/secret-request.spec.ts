import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-03T09:00:00.000Z';

const SESSION = {
  id: 's1',
  kind: 'anonymous',
  title: 'Set up the orders database',
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'supervised',
  account_id: null,
  repo_id: null,
  branch: null,
  pr_number: null,
  pr_action: null,
  connection_ids: null,
  extra_repo_ids: [],
  pull_request: null,
  pull_requests: [],
  alert_id: null,
  state: 'working',
  last_message_preview: null,
  last_error: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook: null,
  queued_message: null,
  spawned_by: null,
  spawned: [],
  subagents: [],
};

test('the agent asks for a secret in a masked field that sends the value once and never shows it again', async ({
  page,
}) => {
  const SECRET = 'hunter2-not-a-real-password';
  let waiting = [{ request_id: 'q1', label: 'Postgres password for orders' }];
  const posted: { url: string; body: unknown }[] = [];
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: [], meta: { next_cursor: null } } }));
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => route.fulfill({ json: { data: [SESSION] } }));
  await page.route(/\/api\/sessions\/s1\/messages$/, (route) => route.fulfill({ json: { data: [] } }));
  await page.route(/\/api\/sessions\/s1\/secret-requests$/, (route) => route.fulfill({ json: { data: waiting } }));
  await page.route(/\/api\/sessions\/s1\/secret-requests\/q1$/, (route) => {
    posted.push({ url: route.request().url(), body: route.request().postDataJSON() });
    waiting = [];
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);

  const card = page.getByRole('listitem', { name: 'Secret needed: Postgres password for orders' });
  const field = card.getByLabel('Postgres password for orders');
  await expect(field).toHaveAttribute('type', 'password');
  await expect(field).toHaveAttribute('autocomplete', 'off');
  await expect(card.getByRole('button', { name: 'Send' })).toBeDisabled();

  await field.fill(SECRET);
  await expect(card.getByRole('button', { name: 'Send' })).toBeEnabled();
  await card.getByRole('button', { name: 'Send' }).click();

  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]?.body).toEqual({ value: SECRET });
  // The value is not in the URL, and the card is gone with the field emptied.
  expect(posted[0]?.url).not.toContain(SECRET);
  await expect(card).toHaveCount(0);
  await expect(page.getByText(SECRET)).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(SECRET);
});

test('a secret request shows again after a reload, and a refused send empties the field', async ({ page }) => {
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: [], meta: { next_cursor: null } } }));
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => route.fulfill({ json: { data: [SESSION] } }));
  await page.route(/\/api\/sessions\/s1\/messages$/, (route) => route.fulfill({ json: { data: [] } }));
  await page.route(/\/api\/sessions\/s1\/secret-requests$/, (route) =>
    route.fulfill({ json: { data: [{ request_id: 'q1', label: 'API key' }] } }),
  );
  await page.route(/\/api\/sessions\/s1\/secret-requests\/q1$/, (route) =>
    route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'no such secret request' } } }),
  );
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);
  await page.reload();

  const card = page.getByRole('listitem', { name: 'Secret needed: API key' });
  await card.getByLabel('API key').fill('typed-secret-value');
  await card.getByRole('button', { name: 'Send' }).click();
  await expect(card.getByRole('alert')).toContainText('The secret was not stored');
  await expect(card.getByLabel('API key')).toHaveValue('');
});
