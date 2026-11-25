import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-01T09:00:00.000Z';

const file = (at: number) => ({
  name: `src/module-${at}.ts`,
  additions: 40,
  deletions: 0,
  lines: Array.from({ length: 40 }, (_, line) => ({ sign: '+' as const, text: `const value${at}_${line} = ${line};` })),
});

const pull = {
  repo_id: 'r1',
  host: 'github',
  slug: 'example/checkout-api',
  number: 7,
  url: 'https://github.com/example/checkout-api/pull/7',
  title: 'A long pull request',
  author: 'me',
  branch: 'fix/long',
  base_branch: 'main',
  head_sha: '9c1e4b7d00000000000000000000000000000000',
  state: 'open',
  review_state: 'none',
  approved_by: [],
  checks: 'passed',
  additions: 400,
  deletions: 0,
  body: '',
  opened_at: NOW,
  merged_at: null,
  is_mine: true,
  by_agent: false,
  comment_count: 0,
  resolved_count: 0,
  agent_session_id: null,
  latest_agent_review: null,
  files: Array.from({ length: 12 }, (_, at) => file(at)),
  comments: [],
  action_sessions: [],
  commits: [],
  conflicts: { state: 'clean', files: [], checked_at: null },
};

test('a pull request keeps its header in view; the files and the decision rail scroll on their own', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 700 });
  await page.route('**/api/sessions', (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route('**/api/repos/r1/pull-requests/7', (route) => route.fulfill({ json: { data: pull } }));
  await page.goto(`${daemon.url}/pull-requests?pr=r1/7#token=${daemon.token}`);
  await page.getByRole('tab', { name: 'Files changed' }).click();

  const title = page.getByRole('heading', { name: /A long pull request/ });
  const panel = page.getByRole('region', { name: 'Files' });
  const rail = page.getByRole('complementary', { name: 'Decision' });
  await expect(panel).toBeVisible();
  // The rail is tied to the other tabs: Files changed gives the diff its width.
  await expect(rail).toHaveCount(0);

  // The header is outside every scroller, so the diff scrolling never moves it.
  const before = await title.boundingBox();
  await panel.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  expect(await panel.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  expect((await title.boundingBox())?.y).toBe(before?.y);

  // On Overview the rail reaches its last section inside the window, whatever the window's height.
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(rail).toBeVisible();
  const last = rail.getByRole('button', { name: 'New Session' });
  await last.scrollIntoViewIfNeeded();
  const box = await last.boundingBox();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(700);

  // Nothing but the panel and the rail scrolls: the page behind them has no scroll of its own.
  const outer = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(outer).toBeLessThanOrEqual(0);
});
