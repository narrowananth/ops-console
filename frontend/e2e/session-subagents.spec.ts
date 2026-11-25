import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-02T09:00:00.000Z';

const subagent = (id: string, description: string, status: string, model: string | null = null) => ({
  id,
  parent_id: null,
  description,
  type: 'general-purpose',
  model,
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

const AGENT_MESSAGE = {
  id: 'm1',
  role: 'agent',
  status: 'done',
  parts: [{ kind: 'text', text: 'Started four audits.' }],
  created_at: NOW,
};

const approval = (id: string, subagentId: string | null) => ({
  id,
  action_log_id: null,
  session_id: 's1',
  kind: 'command',
  summary: 'Run pnpm test',
  status: 'pending',
  requested_at: NOW,
  decided_at: null,
  target: null,
  command: 'pnpm test',
  is_prod: false,
  subagent_id: subagentId,
  trust_cli: null,
});

async function route(page: Page, sessions: unknown[], messages: unknown[] = []) {
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
  await page.route(/\/api\/sessions\/s1\/messages$/, (route) => route.fulfill({ json: { data: messages } }));
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
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);

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
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);
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
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);

  const panel = page.getByRole('complementary', { name: 'Session' });
  await expect(panel.getByText('perf/audit')).toBeVisible();
  await expect(panel.getByText('localhost:60449')).toBeVisible();
  await expect(panel.getByText('Agent runtime perf')).toBeVisible();
  await expect(panel.getByText('general-purpose · Done')).toBeVisible();
  await expect(panel.getByText('general-purpose · Failed')).toBeVisible();

  await panel.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(panel).toHaveCount(0);
});

const FOUR = [
  subagent('t1', 'Agent runtime perf', 'working', 'claude-sonnet-5-5'),
  subagent('t2', 'Integrations perf', 'working'),
  subagent('t3', 'Git perf', 'done'),
  subagent('t4', 'Browser perf', 'failed'),
];

test('the turn that started subagents ends with a row that lists each one and opens its card', async ({ page }) => {
  await route(page, [session({ subagents: FOUR })], [AGENT_MESSAGE]);
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);

  const row = page.getByRole('listitem', { name: 'Subagents' });
  await expect(row.getByText('4 subagents', { exact: true })).toBeVisible();
  await expect(row.getByText('2 working · 1 done · 1 failed')).toBeVisible();
  await expect(row.getByText('+1', { exact: true })).toBeVisible();
  await expect(row.getByText('Git perf')).toHaveCount(0);

  await row.getByRole('button', { expanded: false }).click();
  await expect(row.getByText('Git perf')).toBeVisible();
  await expect(row.getByText('Running', { exact: true })).toHaveCount(2);
  await expect(row.getByText('Done', { exact: true })).toBeVisible();
  await expect(row.getByText('Failed', { exact: true })).toBeVisible();

  await row.getByText('Agent runtime perf').hover();
  const card = page.getByRole('tooltip');
  await expect(card.getByText('Agent runtime perf')).toBeVisible();
  await expect(card.getByText('Sonnet 5.5')).toBeVisible();
  await expect(card.getByText('Running')).toBeVisible();
  await expect(card.getByText('perf/audit')).toBeVisible();
});

test('the row stays away until an agent turn ends the conversation', async ({ page }) => {
  await route(page, [session({ subagents: FOUR })], [{ ...AGENT_MESSAGE, id: 'm0', role: 'user' }]);
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);
  await expect(page.getByText('Waiting on 2 subagents', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('listitem', { name: 'Subagents' })).toHaveCount(0);
});

test('Lineage counts the running subagents and each row opens the same card', async ({ page }) => {
  await route(page, [session({ subagents: FOUR })]);
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);

  const panel = page.getByRole('complementary', { name: 'Session' });
  await expect(panel.getByText('Lineage · 2 running', { exact: true })).toBeVisible();
  await expect(panel.getByText('general-purpose · Running')).toHaveCount(2);

  await panel.getByText('Agent runtime perf').hover();
  const card = page.getByRole('tooltip');
  await expect(card.getByText('Sonnet 5.5')).toBeVisible();
  await expect(card.getByText('perf/audit')).toBeVisible();
});

test('a subagent waiting on an Approval gets a line above the waiting row that opens the Approval', async ({
  page,
}) => {
  await route(page, [session({ state: 'waiting_approval', subagents: FOUR })]);
  await page.route('**/api/approvals?status=pending', (route) =>
    route.fulfill({ json: { data: [approval('a1', 't2'), approval('a2', null)] } }),
  );
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);

  await expect(page.getByText('Subagent needs approval', { exact: true })).toHaveCount(1);
  const line = page.getByText('Subagent needs approval', { exact: true }).locator('..');
  await expect(line.getByText('Integrations perf')).toBeVisible();
  await line.getByRole('button', { name: 'Open approval' }).click();
  await expect(page.locator('[data-approval-id="a1"]')).toBeFocused();
});

test('Syncing messages shows above the composer while the conversation loads', async ({ page }) => {
  await route(page, [session({ state: 'idle' })]);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/sessions\/s1\/messages$/, async (route) => {
    await held;
    await route.fulfill({ json: { data: [AGENT_MESSAGE] } });
  });
  await page.goto(`${daemon.url}/sessions?session=s1#token=${daemon.token}`);

  await expect(page.getByText('Syncing messages…')).toBeVisible();
  release();
  await expect(page.getByText('Started four audits.')).toBeVisible();
  await expect(page.getByText('Syncing messages…')).toHaveCount(0);
});
