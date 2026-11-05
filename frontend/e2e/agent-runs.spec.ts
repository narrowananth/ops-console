import { readFileSync } from 'node:fs';
import { expect, type Page, type Route, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = new Date().toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const REPO = {
  id: 'r1',
  name: 'apis',
  path: '/work/apis',
  host: 'github',
  remote_slug: 'example/apis',
  default_branch: 'main',
  created_at: NOW,
  branch: 'main',
  dirty: false,
  missing: false,
  session_count: 0,
};

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'repo',
  title: `Session ${id}`,
  model: 'claude-sonnet-5-5',
  effort: 'high',
  access_mode: 'supervised',
  account_id: null,
  repo_id: 'r1',
  branch: `feat/${id}`,
  pr_number: null,
  connection_ids: null,
  alert_id: null,
  state: 'working',
  last_message_preview: null,
  last_error: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook: null,
  queued_message: null,
  ...extra,
});

const split = (commands: number) => [
  { phase: 'thinking', ms: 60_000 },
  { phase: 'reading', ms: 90_000 },
  { phase: 'editing', ms: 60_000 },
  { phase: 'commands', ms: commands },
  { phase: 'waiting_you', ms: 0 },
];

const run = (id: string, extra: Record<string, unknown> = {}, sessionExtra: Record<string, unknown> = {}) => ({
  session: session(id, sessionExtra),
  running: true,
  outcome: null,
  started_at: ago(12),
  finished_at: null,
  can_resume: true,
  subagents: [],
  health: 'on_track',
  health_reason: 'On track: Running pnpm lint',
  activity: 'Running pnpm lint',
  cost_usd: null,
  tokens: null,
  split: split(60_000),
  ...extra,
});

const RUNS = [
  run('slow', {
    health: 'slow',
    health_reason: 'Slow: pnpm test backend running 6m 10s, usual 40s',
    split: split(480_000),
    subagents: [
      {
        id: 't1',
        parent_id: null,
        description: 'Explore the writers',
        type: 'Explore',
        status: 'working',
        started_at: ago(10),
        finished_at: null,
      },
    ],
  }),
  run(
    'need',
    { health: 'needs_you', health_reason: 'Waiting on you for 4m: "Apply the fix to prod config too?"' },
    { state: 'waiting_input' },
  ),
  run('ok'),
  run(
    'bad',
    {
      running: false,
      outcome: 'failed',
      finished_at: ago(1),
      health: 'failed',
      health_reason: 'Failed: The agent ran `pnpm install` and it failed.',
    },
    { state: 'failed' },
  ),
  run(
    'stopped',
    {
      running: false,
      outcome: 'stopped',
      finished_at: ago(2),
      health: 'stopped',
      health_reason: 'Stopped by you. Play carries on.',
    },
    { state: 'idle' },
  ),
];

const STAGES = ['read_task', 'explore', 'edit', 'run_tests', 'fix', 'commit', 'open_pr'].map((stage, index) => ({
  stage,
  state: index < 3 ? 'done' : index === 3 ? 'now' : 'todo',
}));

const step = (id: string, summary: string, phase: string, startedMinutesAgo: number, tookMinutes: number | null) => ({
  id,
  agent_id: null,
  tool: summary.startsWith('$ ') ? 'Bash' : 'Read',
  summary,
  phase,
  started_at: ago(startedMinutesAgo),
  finished_at: tookMinutes === null ? null : ago(startedMinutesAgo - tookMinutes),
  ok: tookMinutes === null ? null : true,
  error: null,
});

const detailOf = (id: string, extra: Record<string, unknown> = {}) => ({
  run: RUNS.find((one) => one.session.id === id),
  steps: [step('a', 'Read billing/writer.ts', 'reading', 11, 1), step('b', '$ pnpm test backend', 'commands', 8, null)],
  stages: STAGES,
  slow: null,
  failure: null,
  ...extra,
});

type Calls = { method: string; path: string; body: unknown }[];

/** A daemon with these runs; every control the page uses answers, and each call is kept in order. */
async function routeRuns(page: Page, runs: unknown[] = RUNS): Promise<Calls> {
  const calls: Calls = [];
  const answer = (route: Route, status: number, json?: unknown) => {
    const request = route.request();
    calls.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postData() ? request.postDataJSON() : null,
    });
    return route.fulfill(json === undefined ? { status } : { status, json });
  };
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: [REPO], meta: { next_cursor: null } } }));
  await page.route('**/api/agent-runs', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { data: runs, meta: { next_cursor: null } } })
      : answer(route, 200, { data: { dismissed: 1 } }),
  );
  await page.route('**/api/agent-runs/usage', (route) =>
    route.fulfill({ json: { data: { cost_usd: 0.31, tokens: 48_000, runs: 4 } } }),
  );
  await page.route('**/api/agent-runs/stop-all', (route) => answer(route, 200, { data: { stopped: 3 } }));
  await page.route('**/api/agent-runs/slow', (route) =>
    route.fulfill({
      json: {
        data: detailOf('slow', {
          slow: {
            right_now: 'pnpm test backend has run 6m 10s. It usually takes 40s.',
            likely_cause: 'The command reaches the network.',
            also: 'A message is queued behind this run. It sends when the run ends.',
            suggestion: 'Stop the run and tell the agent to mock the call, or allow the host.',
            blocked_host: 'api.example.com',
          },
        }),
      },
    }),
  );
  await page.route('**/api/agent-runs/bad', (route) =>
    route.fulfill({
      json: {
        data: detailOf('bad', {
          failure: {
            kind: 'network_blocked',
            what_happened: 'The agent ran `pnpm install` and it failed.',
            likely_cause:
              'The Run sandbox lets a command reach listed hosts only. registry.example.com is probably not on the list.',
            what_to_do: 'Allow registry.example.com in the Network allowlist, then Retry.',
            raw: 'ERR_PNPM_FETCH_403 GET https://registry.example.com/left-pad: Forbidden',
            blocked_host: 'registry.example.com',
          },
        }),
      },
    }),
  );
  await page.route(/\/api\/agent-runs\/(ok|need|stopped)$/, (route) =>
    route.fulfill({ json: { data: detailOf(route.request().url().split('/').pop() ?? 'ok') } }),
  );
  await page.route(/\/api\/agent-runs\/[^/]+$/, (route) => {
    if (route.request().method() === 'DELETE') return answer(route, 204);
    return route.fallback();
  });
  await page.route(/\/api\/sessions\/[^/]+\/(pause|stop)$/, (route) => answer(route, 204));
  await page.route(/\/api\/sessions\/[^/]+\/resume$/, (route) => answer(route, 202, { data: { message_id: 'm1' } }));
  await page.route(/\/api\/sessions\/[^/]+\/queue$/, (route) =>
    route.request().method() === 'PUT' ? answer(route, 200, { data: { queued: true } }) : answer(route, 204),
  );
  await page.route(/\/api\/sessions\/[^/]+\/queue\/send$/, (route) => answer(route, 204));
  await page.route('**/api/network-allowlist/domains', (route) =>
    answer(route, 200, { data: { domain: 'registry.example.com', builtin: false } }),
  );
  return calls;
}

const calledPaths = (calls: Calls, method: string) =>
  calls.filter((call) => call.method === method).map((call) => call.path);

test('the page says which runs to look at and why, and the sidebar counts those that need you', async ({ page }) => {
  await routeRuns(page);
  await page.goto(`${daemon.url}/agent-runs#token=${daemon.token}`);

  await expect(page.getByRole('heading', { name: 'Agent runs', level: 1 })).toBeVisible();
  const overview = page.getByRole('region', { name: 'Overview' });
  await expect(overview.getByTitle(/Going as usual/)).toContainText('1');
  await expect(overview.getByTitle(/much longer than the same step/)).toContainText('1');
  await expect(overview.getByTitle(/waits for your yes or no/)).toContainText('1');
  await expect(overview.getByTitle(/ended with an error/)).toContainText('1');
  await expect(overview).toContainText('Today: 4 runs ended · 48k tokens · about $0.31');
  await expect(overview).toContainText('1 run is slower than usual');
  await expect(overview).toContainText('1 run ended with an error');

  // Needs you first, then slow, then failed.
  const cards = page.locator('ul > li').filter({ has: page.getByRole('link', { name: /^Session / }) });
  await expect(cards.nth(0)).toContainText('Session need');
  await expect(cards.nth(1)).toContainText('Session slow');
  await expect(cards.nth(1)).toContainText('Slow: pnpm test backend running 6m 10s, usual 40s');
  await expect(cards.nth(1)).toContainText('1 subagent (1 working)');
  await expect(cards.nth(2)).toContainText('Session bad');

  await expect(page.getByRole('link', { name: /Agent runs/ })).toContainText('1');

  await page.getByRole('tab', { name: /Slow/ }).click();
  await expect(cards).toHaveCount(1);
  await page.getByRole('tab', { name: /Ended/ }).click();
  await expect(cards).toHaveCount(2);

  await page.getByRole('link', { name: 'Session bad' }).click();
  await expect(page).toHaveURL(/\/workspace\?session=bad$/);
});

test('a slow run opens to its stage, where the time went and why, and offers a way out', async ({ page }) => {
  const calls = await routeRuns(page);
  await page.goto(`${daemon.url}/agent-runs?run=slow#token=${daemon.token}`);

  await expect(page.getByText('Why this run is slow')).toBeVisible();
  await expect(page.getByText('The command reaches the network.')).toBeVisible();
  await expect(page.locator('[aria-current="step"]')).toHaveText(/Run tests/);
  await expect(page.getByText(/^Where the .* went/)).toBeVisible();
  await expect(page.getByText(/^Commands and tools/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Timeline/ })).toBeVisible();
  await expect(page.getByTitle('Explore the writers').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Steps/ })).toBeVisible();
  await expect(page.getByText('pnpm test backend', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Stop and tell the agent to skip it' }).click();
  await expect
    .poll(() => calls.filter((call) => call.path.includes('/queue')).map((call) => `${call.method} ${call.path}`))
    .toEqual(['PUT /api/sessions/slow/queue', 'POST /api/sessions/slow/queue/send']);

  await page.getByRole('button', { name: 'Allow api.example.com' }).click();
  await expect
    .poll(() => calls.find((call) => call.path === '/api/network-allowlist/domains')?.body)
    .toEqual({ domain: 'api.example.com' });
});

test('a failed run says what happened, why and what to do, and Allow and Retry does both', async ({ page }) => {
  const calls = await routeRuns(page);
  await page.goto(`${daemon.url}/agent-runs?run=bad#token=${daemon.token}`);

  await expect(page.getByText('Why this run ended')).toBeVisible();
  await expect(page.getByText('Network blocked')).toBeVisible();
  await expect(page.getByText(/registry\.example\.com is probably not on the list/)).toBeVisible();
  await expect(page.getByText('ERR_PNPM_FETCH_403')).toBeVisible();

  await page.getByRole('button', { name: 'Allow registry.example.com and Retry' }).click();
  await expect
    .poll(() => calledPaths(calls, 'POST'))
    .toEqual(['/api/network-allowlist/domains', '/api/sessions/bad/resume']);
});

test('each run pauses, stops, plays, retries and dismisses, and Stop all asks first', async ({ page }) => {
  const calls = await routeRuns(page);
  await page.goto(`${daemon.url}/agent-runs#token=${daemon.token}`);

  const card = (title: string) =>
    page.locator('ul > li').filter({ has: page.getByRole('link', { name: title, exact: true }) });
  await card('Session ok')
    .getByRole('button', { name: /^Pause/ })
    .click();
  await card('Session ok').getByRole('button', { name: 'Stop the run where it is' }).click();
  await card('Session stopped').getByRole('button', { name: /^Play/ }).click();
  await card('Session bad')
    .getByRole('button', { name: /^Retry/ })
    .click();
  await card('Session bad')
    .getByRole('button', { name: /^Dismiss/ })
    .click();
  await expect
    .poll(() => calls.map((call) => `${call.method} ${call.path}`))
    .toEqual([
      'POST /api/sessions/ok/pause',
      'POST /api/sessions/ok/stop',
      'POST /api/sessions/stopped/resume',
      'POST /api/sessions/bad/resume',
      'DELETE /api/agent-runs/bad',
    ]);

  await page.getByRole('button', { name: 'Stop all' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Stop 3 runs?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(calls.some((call) => call.path.endsWith('/stop-all'))).toBe(false);
  await page.getByRole('button', { name: 'Stop all' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop all' }).click();
  await expect.poll(() => calls.some((call) => call.path.endsWith('/stop-all'))).toBe(true);

  await page.getByRole('button', { name: 'Dismiss ended' }).click();
  await expect.poll(() => calls.some((call) => call.method === 'DELETE' && call.path === '/api/agent-runs')).toBe(true);
});

test('with nothing running the page says so, and the tray links to it', async ({ page }) => {
  await routeRuns(page, []);
  await page.goto(`${daemon.url}/repos#token=${daemon.token}`);
  await page.getByRole('button', { name: 'Running agents' }).click();
  await page.getByRole('link', { name: 'Open Agent runs →' }).click();
  await expect(page).toHaveURL(/\/agent-runs$/);
  await expect(page.getByText(/^No agent runs\./)).toBeVisible();
});
