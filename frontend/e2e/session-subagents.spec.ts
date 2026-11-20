import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-02T09:00:00.000Z';

const subagent = (id: string, description: string, status: string) => ({
  id,
  parent_id: null,
  description,
  type: 'general-purpose',
  status,
  started_at: NOW,
  finished_at: status === 'working' ? null : NOW,
});

const session = (extra: Record<string, unknown> = {}) => ({
  id: 's1',
  kind: 'repo',
  title: 'Perf audit',
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'full',
  account_id: null,
  repo_id: 'r1',
  branch: 'perf/audit',
  pr_number: null,
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
  ...extra,
});

async function route(page: Page, sessions: unknown[]) {
  await page.route('**/api/repos', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'r1',
            name: 'orders-api',
            path: '/work/orders-api',
            host: 'github',
            remote_slug: 'example/orders-api',
            origin_slug: null,
            default_branch: 'main',
            created_at: NOW,
            branch: 'main',
            dirty: false,
            missing: false,
            session_count: 1,
          },
        ],
        meta: { next_cursor: null },
      },
    }),
  );
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind');
    return route.fulfill({ json: { data: kind === 'anonymous' ? [] : sessions } });
  });
  await page.route(/\/api\/sessions\/s1\/messages$/, (route) => route.fulfill({ json: { data: [] } }));
}

test('the run waiting on subagents says how many, names them on hover and stops from the row', async ({ page }) => {
  await route(page, [
    session({
      subagents: [
        subagent('t1', 'Agent runtime perf', 'working'),
        subagent('t2', 'Integrations perf', 'working'),
        subagent('t3', 'Git perf', 'done'),
      ],
    }),
  ]);
  let stopped = false;
  await page.route(/\/api\/sessions\/s1\/stop$/, (route) => {
    stopped = true;
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  await expect(page.getByText('Waiting on 2 subagents', { exact: true }).first()).toBeVisible();
  await page.getByText('Waiting on 2 subagents', { exact: true }).first().hover();
  const tip = page.getByRole('tooltip');
  await expect(tip.getByText('Agent runtime perf')).toBeVisible();
  await expect(tip.getByText('Git perf')).toHaveCount(0);

  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect.poll(() => stopped).toBe(true);
});

test('a Session with no working subagent shows no waiting row', async ({ page }) => {
  await route(page, [session({ state: 'idle', subagents: [subagent('t1', 'Done work', 'done')] })]);
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);
  await expect(page.getByRole('heading', { name: 'Perf audit' })).toBeVisible();
  await expect(page.getByText(/Waiting on \d+ subagent/)).toHaveCount(0);
});

test('the Session panel lists the branch, the servers and every subagent with its state', async ({ page }) => {
  await route(page, [
    session({
      state: 'idle',
      subagents: [subagent('t1', 'Agent runtime perf', 'done'), subagent('t2', 'Browser perf', 'failed')],
    }),
  ]);
  await page.route(/\/api\/sessions\/s1\/local-servers$/, (route) =>
    route.fulfill({
      json: {
        data: {
          servers: [{ port: 60449, process: 'node', folder: '/work/orders-api', session_id: 's1', process_id: null }],
        },
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const panel = page.getByRole('complementary', { name: 'Session' });
  await expect(panel.getByText('perf/audit')).toBeVisible();
  await expect(panel.getByText('localhost:60449')).toBeVisible();
  await expect(panel.getByText('Agent runtime perf')).toBeVisible();
  await expect(panel.getByText('general-purpose · done')).toBeVisible();
  await expect(panel.getByText('general-purpose · failed')).toBeVisible();

  await panel.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(panel).toHaveCount(0);
});
