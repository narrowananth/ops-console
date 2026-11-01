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
