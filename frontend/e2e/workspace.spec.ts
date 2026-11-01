import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-10-31T10:00:00.000Z';

const repo = (id: string, name: string, sessionCount = 0) => ({
  id,
  name,
  path: `/work/${name}`,
  host: 'github',
  remote_slug: `example/${name}`,
  default_branch: 'main',
  created_at: NOW,
  branch: 'main',
  dirty: false,
  missing: false,
  session_count: sessionCount,
});

const session = (id: string, repoId: string, title: string, state = 'idle', branch = 'main') => ({
  id,
  kind: 'repo',
  title,
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'auto',
  account_id: null,
  repo_id: repoId,
  branch,
  pr_number: null,
  connection_ids: null,
  state,
  last_message_preview: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook: null,
});

test('a Repo shows its 3 newest Sessions and folds, so the next Repo stays in reach', async ({ page }) => {
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'analytics'), repo('r2', 'apis')], meta: { next_cursor: null } } }),
  );
  await page.route('**/api/repos/*/branches', (route) =>
    route.fulfill({
      json: {
        data: [
          { name: 'main', current: true, has_open_pr: false },
          { name: 'release', current: false, has_open_pr: true },
        ],
      },
    }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({
      json: {
        data: [
          session('s1', 'r1', 'fix login'),
          session('s2', 'r1', 'audit queries'),
          session('s3', 'r1', 'add metrics'),
          session('s4', 'r1', 'old idea'),
          session('s5', 'r1', 'long job', 'working', 'feature/jobs'),
          session('s6', 'r1', 'older idea'),
          session('s7', 'r2', 'check domain'),
        ],
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);

  const analytics = page.getByRole('region', { name: 'analytics' });
  await expect(analytics.getByRole('listitem')).toHaveCount(4);
  await expect(analytics).toContainText('long job');
  await expect(analytics).toContainText('feature/jobs');
  await expect(analytics).toContainText('1 running');
  await expect(analytics).not.toContainText('old idea');
  await analytics.getByRole('button', { name: 'Show 2 more' }).click();
  await expect(analytics.getByRole('listitem')).toHaveCount(6);
  await analytics.getByRole('button', { name: 'Show fewer' }).click();

  const branch = analytics.getByRole('button', { name: 'Branch for a new Session in analytics' });
  await expect(branch).toHaveCount(0);
  await analytics.getByRole('button', { name: 'New Session in analytics' }).click();
  await branch.click();
  await expect(page.getByRole('option', { name: /^main/ })).toContainText('checked out');
  await page.getByRole('option', { name: /^release/ }).click();
  await expect(branch).toContainText('release');

  await analytics.getByRole('button', { name: /^analytics/ }).click();
  await expect(analytics.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'apis' })).toContainText('check domain');
  await page.reload();
  await expect(page.getByRole('region', { name: 'analytics' }).getByRole('listitem')).toHaveCount(0);
});

test('removing a Repo with Sessions asks whether to keep or delete them', async ({ page }) => {
  const removed: string[] = [];
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'analytics', 2), repo('r2', 'apis')], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/repos\/r\d/, (route) => {
    removed.push(new URL(route.request().url()).pathname + new URL(route.request().url()).search);
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Repos' }).click();
  const drawer = page.getByRole('main');

  const analytics = drawer.getByRole('listitem', { name: 'analytics' });
  await analytics.getByRole('button', { name: 'Remove' }).click();
  await expect(analytics).toContainText('It has 2 Sessions');
  await analytics.getByRole('button', { name: 'Keep Sessions' }).click();
  await expect.poll(() => removed).toEqual(['/api/repos/r1?sessions=keep']);

  const apis = drawer.getByRole('listitem', { name: 'apis' });
  await apis.getByRole('button', { name: 'Remove' }).click();
  await expect(apis.getByRole('button', { name: 'Keep Sessions' })).toHaveCount(0);
  await apis.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => removed).toEqual(['/api/repos/r1?sessions=keep', '/api/repos/r2']);
});

test('Stop ends a run waiting on the operator, and Delete waits until it has', async ({ page }) => {
  let state = 'waiting_input';
  const stops: string[] = [];
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'GET /v3/products failing', state)] } }),
  );
  await page.route('**/api/sessions/s1/messages', (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/sessions/s1/stop', (route) => {
    stops.push(route.request().method());
    state = 'idle';
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const header = page.locator('header', { hasText: 'GET /v3/products failing' });
  await expect(header.getByRole('button', { name: 'Delete' })).toBeDisabled();
  // The Session's row in the list stops it too, from its hover.
  await expect(page.getByRole('button', { name: 'Stop GET /v3/products failing' })).toBeAttached();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => stops).toEqual(['POST']);
  await expect(page.getByRole('button', { name: /^Stop/ })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Delete' })).toBeEnabled();
});

test('every message the operator sent copies; the last one edits, reverts the files and runs again', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const said = (id: string, role: string, text: string) => ({
    id,
    role,
    status: 'done',
    parts: [{ kind: 'text', text }],
    created_at: NOW,
  });
  const edits: { url: string; body: unknown }[] = [];
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'engage platform')] } }),
  );
  await page.route('**/api/sessions/s1/messages', (route) =>
    route.fulfill({
      json: {
        data: [
          said('u1', 'user', 'hello'),
          said('a1', 'agent', 'Hello again!'),
          said('u2', 'user', 'explain the engage platform integration'),
          said('a2', 'agent', 'It posts orders to Engage.'),
        ],
      },
    }),
  );
  await page.route('**/api/sessions/s1/messages/*/edit', (route) => {
    edits.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({
      status: 202,
      json: {
        data: {
          message_id: 'm3',
          reverted: { files: ['src/engage.ts'], insertions: 4, deletions: 2 },
          revert_error: null,
        },
      },
    });
  });
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const mine = page.getByRole('listitem', { name: 'Your message' });
  await expect(mine).toHaveCount(2);
  await expect(mine.first().getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await mine.first().hover();
  await mine.first().getByRole('button', { name: 'Copy' }).click();
  await expect(mine.first().getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('hello');

  await mine.last().hover();
  await mine.last().getByRole('button', { name: 'Edit' }).click();
  const box = mine.last().getByRole('textbox', { name: 'Edit message' });
  await expect(box).toHaveValue('explain the engage platform integration');
  await box.fill('explain the engage webhook only');
  await mine.last().getByRole('button', { name: 'Revert and rerun' }).click();

  expect(edits).toEqual([
    {
      url: expect.stringMatching(/\/api\/sessions\/s1\/messages\/u2\/edit$/),
      body: { text: 'explain the engage webhook only' },
    },
  ]);
  await expect(page.getByRole('status')).toHaveText(/Put back 1 file \(\+4 −2\): src\/engage\.ts/);
  await expect(box).toHaveCount(0);
});

test("the agent's tool steps show as a path, the last one turning while the message streams", async ({ page }) => {
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'engage platform', 'working')] } }),
  );
  await page.route('**/api/sessions/s1/messages', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'u1',
            role: 'user',
            status: 'done',
            parts: [{ kind: 'text', text: 'explain engage' }],
            created_at: NOW,
          },
          {
            id: 'a1',
            role: 'agent',
            status: 'streaming',
            parts: [
              { kind: 'text', text: 'Looking.' },
              { kind: 'step', text: '$ ls scripts/platforms' },
              { kind: 'step', text: 'Read scripts/platforms/engage.ts' },
            ],
            created_at: NOW,
          },
        ],
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const steps = page.getByRole('list', { name: 'Agent steps' }).getByRole('listitem');
  await expect(steps).toHaveText([
    /\$ ls scripts\/platforms.*done/,
    /Read scripts\/platforms\/engage\.ts.*in progress/,
  ]);
  await expect(steps.last()).toHaveAttribute('aria-current', 'step');
});
