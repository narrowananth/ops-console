import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-02T09:00:00.000Z';

const REPO = {
  id: 'r1',
  name: 'orders-api',
  path: '/work/orders-api',
  host: 'github',
  remote_slug: 'acme/orders-api',
  origin_slug: null,
  default_branch: 'main',
  created_at: NOW,
  branch: 'main',
  dirty: false,
  missing: false,
  session_count: 1,
};

const SESSION = {
  id: 's1',
  kind: 'repo',
  title: 'Retry the order sync',
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'auto',
  account_id: null,
  repo_id: 'r1',
  branch: 'fix/retry-5',
  pr_number: null,
  pr_action: null,
  connection_ids: null,
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
};

const url = (number: number) => `https://github.com/acme/orders-api/pull/${number}`;
const entry = (number: number) => ({ number, url: url(number), branch: `fix/retry-${number}` });

/** A pull request as the Git host list returns it. */
const listed = (number: number, extra: Record<string, unknown> = {}) => ({
  repo_id: 'r1',
  host: 'github',
  slug: 'acme/orders-api',
  number,
  url: url(number),
  title: `Retry the order sync, part ${number}`,
  author: 'octo',
  branch: `fix/retry-${number}`,
  base_branch: 'main',
  head_sha: 'abc',
  state: 'open',
  review_state: 'none',
  approved_by: [],
  checks: 'passed',
  additions: 3,
  deletions: 1,
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
  ...extra,
});

type Served = unknown[] | 'down';
type Setup = { session?: Record<string, unknown>; list?: Served; merged?: Served; closed?: Served };

/**
 * One Session of the Repo; the Git host list answers per state, or fails. Returns the states the page asked for, in
 * order.
 */
async function open(page: Page, { session = {}, list = [], merged = [], closed = [] }: Setup) {
  const asked: string[] = [];
  const served: Record<string, Served> = { open: list, merged, closed };
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: [REPO], meta: { next_cursor: null } } }));
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind');
    return route.fulfill({
      json: { data: kind === 'anonymous' || kind === 'devtools' ? [] : [{ ...SESSION, ...session }] },
    });
  });
  await page.route('**/api/sessions/s1/messages', (route) => route.fulfill({ json: { data: [] } }));
  await page.route(/\/api\/pull-requests\?/, (route) => {
    const state = new URL(route.request().url()).searchParams.get('state') ?? 'open';
    asked.push(state);
    const answer = served[state];
    return answer === 'down'
      ? route.fulfill({ status: 502, json: { error: { code: 'git_host_down', message: 'The Git host is down.' } } })
      : route.fulfill({ json: { data: answer, meta: { synced_at: NOW, stale: false, next_cursor: null } } });
  });
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);
  return asked;
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Session' });

test('one pull request looks as the single row did: title, both links and the checks', async ({ page }) => {
  await open(page, {
    session: { pull_request: { number: 5, url: url(5) }, pull_requests: [entry(5)] },
    list: [listed(5, { checks: 'failed' })],
  });
  const card = panel(page);
  await expect(card.getByText('Retry the order sync, part 5')).toBeVisible();
  await expect(card.getByRole('link', { name: /^PR #5/ })).toHaveAttribute('href', /\/pull-requests\?pr=r1%2F5$/);
  await expect(card.getByRole('link', { name: /#5 on host/ })).toHaveAttribute('href', url(5));
  await expect(card.getByText('checks failed')).toBeVisible();
  await expect(card.getByRole('button', { name: /Show \d+ more/ })).toHaveCount(0);
});

test('five pull requests show three, then Show 2 more opens the rest and Show less folds them', async ({ page }) => {
  await open(page, {
    session: { pull_request: { number: 5, url: url(5) }, pull_requests: [5, 4, 3, 2, 1].map(entry) },
    list: [5, 4, 3, 2, 1].map((n) => listed(n)),
  });
  const card = panel(page);
  const titles = card.getByText(/^Retry the order sync, part \d$/);
  await expect(titles).toHaveText([
    'Retry the order sync, part 5',
    'Retry the order sync, part 4',
    'Retry the order sync, part 3',
  ]);

  await card.getByRole('button', { name: 'Show 2 more' }).click();
  await expect(titles).toHaveCount(5);
  await expect(titles.last()).toHaveText('Retry the order sync, part 1');

  await card.getByRole('button', { name: 'Show less' }).click();
  await expect(titles).toHaveCount(3);
  await expect(card.getByRole('button', { name: 'Show 2 more' })).toBeVisible();
});

test('a row takes its title, state and checks from the Git host list, and one the list lacks shows number and link', async ({
  page,
}) => {
  await open(page, {
    session: { pull_request: { number: 5, url: url(5) }, pull_requests: [entry(5), entry(4)] },
    list: [listed(5, { checks: 'running' })],
  });
  const card = panel(page);
  await expect(card.getByText('Retry the order sync, part 5')).toBeVisible();
  await expect(card.getByText('checks running')).toBeVisible();
  await expect(card.getByText('open', { exact: true })).toHaveCount(1);
  // #4 is no longer in the open list: its number and its links remain.
  await expect(card.getByText('Pull request #4')).toBeVisible();
  await expect(card.getByRole('link', { name: /#4 on host/ })).toHaveAttribute('href', url(4));
  await expect(card.getByText(/checks (running|passed|failed)/)).toHaveCount(1);
});

test('a Session on a branch with no pull request of its own still lists the ones it opened', async ({ page }) => {
  await open(page, {
    session: { branch: 'fix/other', pull_request: null, pull_requests: [entry(5), entry(4)] },
    list: [listed(5), listed(4)],
  });
  const card = panel(page);
  await expect(card.getByRole('link', { name: /#5 on host/ })).toBeVisible();
  await expect(card.getByRole('link', { name: /#4 on host/ })).toBeVisible();
});

test('a Session with no pull request opened shows no list', async ({ page }) => {
  await open(page, { list: [listed(5, { branch: 'fix/elsewhere' })] });
  await expect(page.locator('header').getByRole('heading', { name: 'Retry the order sync' })).toBeVisible();
  await expect(panel(page).getByRole('link', { name: /on host/ })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: /^Show (\d+ more|less)$/ })).toHaveCount(0);
});

test('a pr_review Session shows no list', async ({ page }) => {
  await open(page, {
    session: { kind: 'pr_review', pr_number: 9, pull_requests: [entry(5)] },
    list: [listed(5)],
  });
  await expect(page.locator('header').getByRole('heading', { name: 'Retry the order sync' })).toBeVisible();
  await expect(panel(page).getByRole('link', { name: /on host/ })).toHaveCount(0);
});

test('with the Git host list down the rows still show their numbers and links, and no error', async ({ page }) => {
  await open(page, {
    session: { pull_request: { number: 5, url: url(5) }, pull_requests: [entry(5), entry(4)] },
    list: 'down',
  });
  const card = panel(page);
  await expect(card.getByText('Pull request #5')).toBeVisible();
  await expect(card.getByText('Pull request #4')).toBeVisible();
  await expect(card.getByRole('link', { name: /#4 on host/ })).toHaveAttribute('href', url(4));
  await expect(card.getByText(/checks /)).toHaveCount(0);
  await expect(card.getByRole('alert')).toHaveCount(0);
});

test('a merged and a closed pull request show their state from those lists, and one in no list shows number and link', async ({
  page,
}) => {
  const asked = await open(page, {
    session: { pull_request: { number: 5, url: url(5) }, pull_requests: [5, 4, 3, 2].map(entry) },
    list: [listed(5)],
    merged: [listed(4, { state: 'merged', merged_at: NOW, checks: 'none' })],
    closed: [listed(3, { state: 'closed', checks: 'failed' })],
  });
  const card = panel(page);
  await card.getByRole('button', { name: 'Show 1 more' }).click();
  const row = (number: number) =>
    card.getByText(new RegExp(`part ${number}$|^Pull request #${number}$`)).locator('xpath=../..');
  await expect(row(5)).toContainText('open');
  await expect(row(4)).toContainText('merged');
  await expect(row(3)).toContainText('closed');
  await expect(row(3)).toContainText('checks failed');
  await expect(card.getByText('Pull request #2')).toBeVisible();
  await expect(card.getByRole('link', { name: /#2 on host/ })).toHaveAttribute('href', url(2));
  await expect(card.getByRole('alert')).toHaveCount(0);
  expect(asked.filter((state) => state === 'merged')).not.toHaveLength(0);
  expect(asked.filter((state) => state === 'closed')).not.toHaveLength(0);
});

test('failing merged and closed lists leave the row with its number and link, and no error', async ({ page }) => {
  await open(page, {
    session: { pull_request: { number: 5, url: url(5) }, pull_requests: [entry(5), entry(4)] },
    list: [listed(5)],
    merged: 'down',
    closed: 'down',
  });
  const card = panel(page);
  await expect(card.getByText('Pull request #4')).toBeVisible();
  await expect(card.getByRole('link', { name: /#4 on host/ })).toHaveAttribute('href', url(4));
  await expect(card.getByRole('alert')).toHaveCount(0);
});

test('the merged and closed lists are not read while every pull request is open', async ({ page }) => {
  const asked = await open(page, {
    session: { pull_request: { number: 5, url: url(5) }, pull_requests: [entry(5), entry(4)] },
    list: [listed(5), listed(4)],
  });
  await expect(panel(page).getByText('Retry the order sync, part 4')).toBeVisible();
  // Any read that was going to start has gone out once the network is quiet.
  await page.waitForLoadState('networkidle');
  expect(asked).not.toContain('merged');
  expect(asked).not.toContain('closed');
});
