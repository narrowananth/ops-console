import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-02T09:00:00.000Z';

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
    return route.fulfill({ json: { data: kind === 'anonymous' || kind === 'devtools' ? [] : sessions } });
  });
  await page.route(/\/api\/sessions\/s1\/messages$/, (route) => route.fulfill({ json: { data: [] } }));
}

const pull = (checks: string) => ({
  repo_id: 'r1',
  host: 'github',
  slug: 'example/orders-api',
  number: 106,
  url: 'https://github.com/example/orders-api/pull/106',
  title: 'Browser: send input in order',
  author: 'octo',
  branch: 'perf/audit',
  base_branch: 'main',
  head_sha: 'abc',
  state: 'open',
  review_state: 'none',
  approved_by: [],
  checks,
  additions: 3,
  deletions: 1,
  body: '',
  opened_at: NOW,
  merged_at: null,
  is_mine: true,
  by_agent: false,
  comment_count: 0,
  resolved_count: 0,
  agent_session_id: null,
  latest_agent_review: null,
  conflicts: null,
  mergeable: true,
});

async function open(page: Page, uncommitted: number, extra: Record<string, unknown> = {}) {
  await route(page, [session({ state: 'idle', ...extra })]);
  await page.route(/\/api\/sessions\/s1\/diff$/, (route) =>
    route.fulfill({
      json: {
        data: {
          branch: 'perf/audit',
          base: 'main',
          files: [
            {
              name: 'a.ts',
              status: 'modified',
              additions: 3,
              deletions: 1,
              binary: false,
              truncated: false,
              lines: [],
            },
          ],
          additions: 3,
          deletions: 1,
        },
      },
    }),
  );
  await page.route(/\/api\/sessions\/s1\/pull-request$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      json: {
        data: {
          can_open: extra.pull_request ? false : true,
          pull_request: extra.pull_request ?? null,
          base_branch: 'main',
          uncommitted_files: uncommitted,
        },
      },
    });
  });
  await page.route(/\/api\/pull-requests(\?.*)?$/, (route) =>
    route.fulfill({ json: { data: [pull('passed')], meta: { synced_at: NOW, stale: false, next_cursor: null } } }),
  );
  await page.route(/\/api\/repos\/r1\/pull-requests(\?.*)?$/, (route) =>
    route.fulfill({ json: { data: [pull('passed')], meta: { synced_at: NOW, stale: false, next_cursor: null } } }),
  );
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);
}

test('the card opens the folder in VS Code and the file manager', async ({ page }) => {
  const targets: unknown[] = [];
  await page.route(/\/api\/sessions\/s1\/open-folder$/, (route) => {
    targets.push(route.request().postDataJSON());
    return route.fulfill({ status: 204, body: '' });
  });
  await open(page, 0);
  const card = page.getByRole('complementary', { name: 'Session' });
  await card.getByRole('button', { name: 'Open in VS Code' }).click();
  await card.getByRole('button', { name: 'Show the folder' }).click();
  await expect.poll(() => targets).toEqual([{ target: 'editor' }, { target: 'folder' }]);
});

test('Commit asks for a message, may leave it blank, and may commit on a new branch', async ({ page }) => {
  const sent: unknown[] = [];
  await page.route(/\/api\/sessions\/s1\/commit$/, (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      json: { data: { sha: 'abc', branch: 'perf/audit', message: 'Update a.ts', files: 2 } },
    });
  });
  await open(page, 2);
  const card = page.getByRole('complementary', { name: 'Session' });
  // Files are uncommitted, so the row itself is Commit.
  await card.getByRole('button', { name: 'Commit, push & PR' }).click();
  const dialog = page.getByRole('dialog', { name: 'Commit changes' });
  await expect(dialog).toContainText('2 files not committed yet');
  await dialog.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await card.getByRole('button', { name: 'Commit, push and PR options' }).click();
  await card.getByRole('menuitem', { name: /^Commit/ }).click();
  await page.getByRole('textbox', { name: /Commit message/ }).fill('Add a');
  await page.getByRole('button', { name: 'Commit on new branch' }).click();
  await expect
    .poll(() => sent)
    .toEqual([
      { message: '', new_branch: false },
      { message: 'Add a', new_branch: true },
    ]);
});

test('Push sends the branch, and Commit is off when nothing is uncommitted', async ({ page }) => {
  let pushed = 0;
  await page.route(/\/api\/sessions\/s1\/push$/, (route) => {
    pushed += 1;
    return route.fulfill({ json: { data: { branch: 'perf/audit' } } });
  });
  await open(page, 0, { pull_request: { number: 106, url: 'https://github.com/example/orders-api/pull/106' } });
  const card = page.getByRole('complementary', { name: 'Session' });
  await card.getByRole('button', { name: 'Commit, push and PR options' }).click();
  await expect(card.getByRole('menuitem', { name: /^Commit/ })).toBeDisabled();
  await expect(card.getByRole('menuitem', { name: 'Create PR' })).toBeDisabled();
  await card.getByRole('menuitem', { name: 'Push' }).click();
  await expect.poll(() => pushed).toBe(1);
});

test('the card shows the pull request title with its CI state', async ({ page }) => {
  await open(page, 0, { pull_request: { number: 106, url: 'https://github.com/example/orders-api/pull/106' } });
  const card = page.getByRole('complementary', { name: 'Session' });
  await expect(card.getByText('Browser: send input in order')).toBeVisible();
  await expect(card.getByText('checks passed')).toBeVisible();
});

test('Delete asks first, and Cancel leaves the Session alone', async ({ page }) => {
  let deleted = 0;
  await page.route(/\/api\/sessions\/s1$/, (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    deleted += 1;
    return route.fulfill({ status: 204, body: '' });
  });
  await open(page, 0);
  const card = page.getByRole('complementary', { name: 'Session' });
  await card.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this Session?' });
  await expect(dialog).toContainText('Perf audit');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(deleted).toBe(0);
  await card.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => deleted).toBe(1);
});

test('the composer and the card have rounded corners, and a chip list opens inside the window', async ({ page }) => {
  await open(page, 0);
  const card = page.getByRole('complementary', { name: 'Session' }).locator('> div');
  expect(await card.evaluate((node) => getComputedStyle(node).borderTopLeftRadius)).not.toBe('0px');
  const box = page
    .getByRole('textbox', { name: 'Message' })
    .locator('xpath=ancestor::div[contains(@class,"rounded-3xl")][1]');
  expect(await box.evaluate((node) => getComputedStyle(node).borderTopLeftRadius)).not.toBe('0px');

  for (const width of [1100, 800]) {
    await page.setViewportSize({ width, height: 800 });
    // Below 1100 the Session panel floats over the page; the narrow composer is the one to check.
    if (width < 1100) await page.getByRole('button', { name: 'Close the Session panel' }).click();
    await page.getByRole('button', { name: 'Model, effort and access' }).click();
    const popover = page.getByRole('dialog', { name: 'Model, effort and access' });
    await expect(popover).toBeVisible();
    const edges = await popover.evaluate((node) => {
      const { left, right } = node.getBoundingClientRect();
      return { left, right, overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
    expect(edges.left).toBeGreaterThanOrEqual(0);
    expect(edges.right).toBeLessThanOrEqual(width);
    expect(edges.overflow).toBeLessThanOrEqual(0);
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
  }
});
