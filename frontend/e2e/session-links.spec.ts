import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-02T09:00:00.000Z';

const REPO = {
  id: 'r1',
  name: 'checkout-api',
  path: '/work/checkout-api',
  host: 'github',
  remote_slug: 'example/checkout-api',
  default_branch: 'main',
  created_at: NOW,
  branch: 'main',
  dirty: false,
  missing: false,
  session_count: 1,
};

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'repo',
  title: `Session ${id}`,
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
  ...extra,
});

const PR = {
  repo_id: 'r1',
  host: 'github',
  slug: 'example/checkout-api',
  number: 7,
  url: 'https://github.com/example/checkout-api/pull/7',
  title: 'Guard empty carts',
  author: 'me',
  branch: 'fix/empty-cart',
  base_branch: 'main',
  head_sha: '9c1e4b7d00000000000000000000000000000000',
  state: 'open',
  review_state: 'none',
  approved_by: [],
  checks: 'passed',
  additions: 3,
  deletions: 1,
  body: '',
  opened_at: NOW,
  merged_at: null,
  is_mine: true,
  by_agent: true,
  comment_count: 0,
  resolved_count: 0,
  agent_session_id: null,
  latest_agent_review: null,
};

/** One Repo with Session s1 on the pull request's branch; `all` answers the list of every kind, `running` included. */
async function routeWorkspace(page: Page, all: unknown[] = [session('s1')]) {
  const created: unknown[] = [];
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: [REPO], meta: { next_cursor: null } } }));
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      created.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { data: session('s2', { title: 'New Session' }) } });
    }
    const kind = url.searchParams.get('kind');
    const inRepo = [session('s1'), ...(created.length > 0 ? [session('s2', { title: 'New Session' })] : [])];
    return route.fulfill({ json: { data: kind === 'anonymous' ? [] : kind === null ? all : inRepo } });
  });
  await page.route(/\/api\/sessions\/s\d\/messages$/, (route) => route.fulfill({ json: { data: [] } }));
  await page.route(/\/api\/pull-requests\?/, (route) =>
    route.fulfill({ json: { data: [PR], meta: { synced_at: NOW, stale: false, next_cursor: null } } }),
  );
  await page.route('**/api/repos/r1/pull-requests/7', (route) =>
    route.fulfill({ json: { data: { ...PR, files: [], comments: [], reply_checks: [], comment_passes: [] } } }),
  );
  return created;
}

test('a pull request links the Sessions on its branch, and New Session opens one there with the PR in its draft', async ({
  page,
}) => {
  const created = await routeWorkspace(page);
  await page.goto(`${daemon.url}/workspace?tab=pulls&pr=r1%2F7#token=${daemon.token}`);

  await expect(page.getByText('Sessions on fix/empty-cart:')).toBeVisible();
  await page.getByRole('link', { name: 'Session s1 · idle' }).click();
  await expect(page).toHaveURL(/\/workspace\?session=s1$/);
  await expect(page.getByRole('heading', { name: 'Session s1' })).toBeVisible();

  await page.goBack();
  await page.getByRole('button', { name: 'New Session' }).click();
  await expect(page).toHaveURL(/\/workspace\?session=s2$/);
  await expect.poll(() => created).toEqual([{ repo_id: 'r1', branch: 'fix/empty-cart', from_origin: true }]);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveText('On pull request #7 (Guard empty carts): ');
});

test('a Session links its pull request and its Monitor Alert', async ({ page }) => {
  await routeWorkspace(page, [session('s1', { alert_id: 'a1' })]);
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', { alert_id: 'a1' })] } }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  await expect(page.getByRole('link', { name: 'Alert →' })).toHaveAttribute('href', '/monitor?alert=a1');
  await page.getByRole('link', { name: 'PR #7 →' }).click();
  await expect(page).toHaveURL(/\/workspace\?tab=pulls&pr=r1%2F7$/);
  await expect(page.getByRole('heading', { name: '#7 Guard empty carts' })).toBeVisible();
});

const run = (id: string, extra: Record<string, unknown> = {}, sessionExtra: Record<string, unknown> = {}) => ({
  session: session(id, sessionExtra),
  running: true,
  outcome: null,
  started_at: NOW,
  finished_at: null,
  can_resume: true,
  can_retry: true,
  subagents: [],
  health: 'on_track',
  health_reason: 'On track: the agent is thinking',
  activity: null,
  cost_usd: null,
  tokens: null,
  usage: null,
  limit: null,
  split: [],
  ...extra,
});

test('the sidebar tray lists every agent run going, says which wait on the operator, and opens each', async ({
  page,
}) => {
  await routeWorkspace(page);
  await page.route('**/api/agent-runs', (route) =>
    route.fulfill({
      json: {
        data: [
          run('s1', {}, { state: 'working', title: 'Add a retry' }),
          run(
            's3',
            { health: 'needs_you', health_reason: 'Waiting on you for 1m' },
            { state: 'waiting_approval', title: 'Drop the old index', branch: 'main' },
          ),
          run(
            's4',
            { can_resume: false, can_retry: false },
            { kind: 'pr_review', state: 'working', pr_number: 7, title: 'PR #7' },
          ),
        ],
        meta: { next_cursor: null },
      },
    }),
  );
  await page.goto(`${daemon.url}/repos#token=${daemon.token}`);

  const tray = page.getByRole('button', { name: 'Running agents' });
  await expect(tray).toHaveText(/3 running/);
  await expect(tray).toHaveAttribute('title', '3 agent runs going, 1 waiting on you');
  await tray.click();
  const dialog = page.getByRole('dialog', { name: 'Agent runs' });
  await expect(dialog).toContainText('3 agent runs');
  await expect(dialog).toContainText('3 going · 1 needs you · 0 ended');
  const runs = dialog.getByRole('listitem');
  await expect(runs).toHaveText([/Drop the old index.*needs you/, /Add a retry.*working/, /Pull request #7.*working/]);

  await dialog.getByRole('link', { name: 'Pull request #7' }).click();
  await expect(page).toHaveURL(/\/workspace\?tab=pulls&pr=r1%2F7$/);
  await expect(dialog).toBeHidden();
  await tray.click();
  await dialog.getByRole('link', { name: 'Session · Add a retry' }).click();
  await expect(page).toHaveURL(/\/workspace\?session=s1$/);
});

test('the tray shows how long a run took, nests its subagents, and pauses, stops, plays and retries runs', async ({
  page,
}) => {
  await routeWorkspace(page);
  const calls: string[] = [];
  const subagent = (id: string, parent: string | null, status: string) => ({
    id,
    parent_id: parent,
    description: `Task ${id}`,
    type: 'Explore',
    status,
    started_at: NOW,
    finished_at: status === 'working' ? null : '2026-11-02T09:02:05.000Z',
  });
  await page.route('**/api/agent-runs', (route) =>
    route.fulfill({
      json: {
        data: [
          run(
            's1',
            { subagents: [subagent('t1', null, 'working'), subagent('t2', 't1', 'done')] },
            { state: 'working', title: 'Add a retry' },
          ),
          run(
            's3',
            { running: false, outcome: 'rate_limited', finished_at: '2026-11-02T09:04:05.000Z' },
            { title: 'Hit the limit' },
          ),
          run(
            's5',
            { running: false, outcome: 'paused', finished_at: '2026-11-02T09:01:00.000Z' },
            { title: 'Paused one' },
          ),
        ],
        meta: { next_cursor: null },
      },
    }),
  );
  for (const action of ['pause', 'stop']) {
    await page.route(`**/api/sessions/s1/${action}`, (route) => {
      calls.push(`${action} s1`);
      return route.fulfill({ status: 204 });
    });
  }
  await page.route('**/api/sessions/s*/resume', (route) => {
    calls.push(`resume ${route.request().url().split('/').at(-2)}`);
    return route.fulfill({ status: 202, json: { data: { message_id: 'm1' } } });
  });
  await page.route('**/api/agent-runs/s5', (route) => {
    calls.push('dismiss s5');
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${daemon.url}/repos#token=${daemon.token}`);

  const tray = page.getByRole('button', { name: 'Running agents' });
  await expect(tray).toHaveAttribute('title', '1 agent run going, 2 ended');
  await tray.click();
  const runs = page.getByRole('dialog', { name: 'Agent runs' }).getByRole('listitem');
  const main = runs.filter({ hasText: 'Add a retry' }).first();
  await expect(page.getByText('Task t1')).toBeHidden();
  await main.getByRole('button', { name: 'Show details of Add a retry' }).click();
  await expect(main).toContainText('2 subagents (1 working)');
  await expect(page.getByText('Task t1')).toBeVisible();
  await expect(page.getByText('Task t2')).toBeVisible();

  const limited = runs.filter({ hasText: 'Hit the limit' });
  await expect(limited).toContainText('limit reached');
  await expect(limited).toContainText('4m 05s');
  await main.getByRole('button', { name: /^Pause/ }).click();
  await main.getByRole('button', { name: 'Stop the run where it is' }).click();
  await limited.getByRole('button', { name: /^Retry/ }).click();
  const paused = runs.filter({ hasText: 'Paused one' });
  await paused.getByRole('button', { name: /^Play/ }).click();
  await paused.getByRole('button', { name: /^Dismiss/ }).click();
  await expect.poll(() => calls).toEqual(['pause s1', 'stop s1', 'resume s3', 'resume s5', 'dismiss s5']);
});
