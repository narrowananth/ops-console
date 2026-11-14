import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-02T09:00:00.000Z';

const repo = (id: string, name: string) => ({
  id,
  name,
  path: `/work/${name}`,
  host: 'github',
  remote_slug: `example/${name}`,
  origin_slug: null,
  default_branch: 'main',
  created_at: NOW,
  branch: 'main',
  dirty: false,
  missing: false,
  session_count: 1,
});

const session = (id: string, repoId: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'repo',
  title: `Session ${id}`,
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'auto',
  account_id: null,
  repo_id: repoId,
  branch: 'main',
  pr_number: null,
  connection_ids: null,
  extra_repo_ids: [],
  pull_request: null,
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
  ...extra,
});

const child = (id: string, repoName: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Session ${id}`,
  call_id: 'call-1',
  repo_name: repoName,
  branch: 'main',
  state: 'working',
  run_outcome: null,
  pull_request: null,
  ...extra,
});

const SPAWN_MESSAGE = {
  id: 'm1',
  role: 'agent',
  status: 'done',
  created_at: NOW,
  parts: [
    {
      kind: 'spawn',
      call_id: 'call-1',
      entries: [
        { repo: 'web', task: 'Fix the cart total.' },
        { repo: 'billing', task: 'Round invoices.' },
      ],
    },
  ],
};

async function route(page: Page, sessions: unknown[]) {
  await page.route('**/api/repos', (route) =>
    route.fulfill({
      json: { data: [repo('r1', 'orders-api'), repo('r2', 'web'), repo('r3', 'billing')], meta: { next_cursor: null } },
    }),
  );
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind');
    return route.fulfill({ json: { data: kind === 'anonymous' ? [] : sessions } });
  });
  await page.route(/\/api\/sessions\/s1\/messages$/, (route) => route.fulfill({ json: { data: [SPAWN_MESSAGE] } }));
  await page.route(/\/api\/sessions\/s[23]\/messages$/, (route) => route.fulfill({ json: { data: [] } }));
}

test('the batch card lists each Session the call started, and opens one; the child names its parent', async ({
  page,
}) => {
  const started = [
    child('s2', 'web', { branch: 'fix/cart-total', pull_request: { number: 12, url: 'https://example.com/pull/12' } }),
    child('s3', 'billing', { state: 'idle', run_outcome: 'failed' }),
    // Another call's child never shows on this card.
    child('s4', 'orders-api', { call_id: 'call-2' }),
  ];
  await route(page, [
    session('s1', 'r1', { spawned: started }),
    session('s2', 'r2', { branch: 'fix/cart-total', spawned_by: { id: 's1', title: 'Session s1' } }),
    session('s3', 'r3', { spawned_by: { id: 's1', title: 'Session s1' } }),
  ]);
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const card = page.getByRole('region', { name: 'Sessions started together' });
  await expect(card.getByText('Started 2 of 2 Sessions')).toBeVisible();
  await expect(card.getByText('web', { exact: true })).toBeVisible();
  await expect(card.getByText('fix/cart-total')).toBeVisible();
  await expect(card.getByRole('link', { name: 'PR #12 ↗' })).toHaveAttribute('href', 'https://example.com/pull/12');
  await expect(card.getByText('failed', { exact: true })).toBeVisible();
  await expect(card.getByText('orders-api')).toHaveCount(0);

  await card.getByRole('link', { name: 'Open' }).first().click();
  await expect(page).toHaveURL(/\/workspace\?session=s2$/);
  await expect(page.getByRole('link', { name: 'Started from Session s1 →' })).toBeVisible();
});

test('the batch card says nothing started when the Approval was denied', async ({ page }) => {
  await route(page, [session('s1', 'r1')]);
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const card = page.getByRole('region', { name: 'Sessions started together' });
  await expect(card.getByText('2 Sessions asked for')).toBeVisible();
  await expect(card.getByText(/Not started: the Approval was denied/)).toBeVisible();
});
