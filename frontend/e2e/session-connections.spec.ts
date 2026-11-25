import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-02T09:00:00.000Z';

const connection = (id: string, name: string, type: string, env: string, access: string) => ({
  id,
  name,
  type,
  env,
  access,
  config: {},
  status: 'ok',
  status_detail: null,
  latency_ms: 4,
  last_checked_at: NOW,
  created_at: NOW,
  is_prod: env === 'prod',
  secret_stored: true,
});

const CONNECTIONS = [
  connection('c2', 'pg-tenant', 'postgres', 'local', 'read'),
  connection('c1', 'mongo-prod', 'mongodb', 'prod', 'read'),
  connection('c3', 'redis-local', 'redis', 'local', 'none'),
];

const session = (ids: string[]) => ({
  id: 's1',
  kind: 'anonymous',
  title: 'Where is acme stored',
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'full',
  account_id: null,
  repo_id: null,
  branch: null,
  pr_number: null,
  pr_action: null,
  connection_ids: ids,
  extra_repo_ids: [],
  pull_request: null,
  pull_requests: [],
  alert_id: null,
  state: 'idle',
  last_message_preview: null,
  last_error: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook: null,
  queued_message: null,
  spawned_by: null,
  spawned: [],
  subagents: [],
});

/** The daemon as one Session sees it: a PATCH of `connection_ids` is kept and read back. */
async function route(page: Page, connections: unknown[]) {
  let ids: string[] = [];
  const patches: unknown[] = [];
  await page.route('**/api/connections', (route) =>
    route.fulfill({ json: { data: connections, meta: { next_cursor: null } } }),
  );
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: [], meta: { next_cursor: null } } }));
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind');
    return route.fulfill({ json: { data: kind === 'repo' ? [] : [session(ids)] } });
  });
  await page.route(/\/api\/sessions\/s1\/messages$/, (route) => route.fulfill({ json: { data: [] } }));
  await page.route(/\/api\/sessions\/s1$/, (route) => {
    if (route.request().method() !== 'PATCH') return route.fulfill({ json: { data: session(ids) } });
    const body = route.request().postDataJSON() as { connection_ids: string[] };
    patches.push(body);
    ids = body.connection_ids;
    return route.fulfill({ json: { data: session(ids) } });
  });
  return patches;
}

test('the composer ticks Connections A to Z, shows PROD and a count, and the Session panel lists the ticked ones', async ({
  page,
}) => {
  const patches = await route(page, CONNECTIONS);
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);

  const icon = page.getByRole('button', { name: 'Connections: none' });
  await expect(icon).toBeVisible();
  await icon.click();
  const menu = page.locator('[data-session-connections]');
  await expect(menu.getByRole('button')).toHaveText([/mongo-prod\s*PROD/, /pg-tenant/, /redis-local/]);
  await expect(menu.getByRole('button', { name: /redis-local/ })).toBeDisabled();
  await expect(page.getByText('Greyed Connections have Access Level none')).toBeVisible();

  await menu.getByRole('button', { name: /mongo-prod/ }).click();
  await expect(page.getByRole('button', { name: 'Connections: mongo-prod' })).toContainText('1');
  await expect.poll(() => patches).toEqual([{ connection_ids: ['c1'] }]);
  await expect(menu.getByRole('button', { name: /mongo-prod/ })).toHaveAttribute('aria-pressed', 'true');

  await menu.getByRole('button', { name: 'pg-tenant' }).click();
  await expect.poll(() => patches).toEqual([{ connection_ids: ['c1'] }, { connection_ids: ['c1', 'c2'] }]);
  await page.keyboard.press('Escape');

  // The ticked ones survive a reload and show as chips in the Session panel.
  await page.reload();
  const chips = page
    .getByRole('complementary', { name: 'Session' })
    .getByRole('list', { name: 'Connections the agent may reach' });
  await expect(chips.getByRole('listitem')).toHaveText([/mongo-prod\s*PROD/, /pg-tenant/]);
});

test('with no Connections the menu says so and links to Connections', async ({ page }) => {
  await route(page, []);
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);
  await page.getByRole('button', { name: 'Connections: none' }).click();
  await expect(page.getByText('No Connections yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Add one in Connections' }).click();
  await expect(page).toHaveURL(/\/connections/);
});
