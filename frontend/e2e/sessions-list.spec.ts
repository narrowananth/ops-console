import { readFileSync } from 'node:fs';
import { expect, type Page, test, type WebSocketRoute } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-02T09:00:00.000Z';

const repo = (extra: Record<string, unknown> = {}) => ({
  id: 'r1',
  name: 'checkout-api',
  path: '/work/checkout-api',
  host: 'github',
  remote_slug: 'example/checkout-api',
  origin_slug: null,
  default_branch: 'main',
  created_at: NOW,
  branch: 'main',
  dirty: false,
  missing: false,
  session_count: 2,
  ...extra,
});

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'repo',
  title: `Session ${id}`,
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'auto',
  account_id: null,
  repo_id: 'r1',
  branch: 'main',
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
  ...extra,
});

const pull = (number: number, title: string, state = 'open') => ({
  repo_id: 'r1',
  host: 'github',
  slug: 'example/checkout-api',
  number,
  url: `https://example.com/pull/${number}`,
  title,
  author: 'me',
  branch: `b${number}`,
  base_branch: 'main',
  head_sha: 'abc',
  state,
  review_state: 'none',
  approved_by: [],
  checks: 'none',
  additions: 1,
  deletions: 1,
  opened_at: NOW,
  merged_at: null,
  is_mine: true,
  by_agent: false,
  comment_count: 0,
  resolved_count: 0,
  agent_session_id: null,
  latest_agent_review: null,
});

const said = (id: string, role: string, text: string) => ({
  id,
  role,
  status: 'done',
  parts: [{ kind: 'text', text }],
  created_at: NOW,
});

type Options = {
  repoExtra?: Record<string, unknown>;
  messages?: Record<string, unknown[]>;
  runs?: unknown[];
  pulls?: ReturnType<typeof pull>[];
};

/** One Repo and the given Sessions; every Session's messages answer from `messages` (empty by default). */
async function routeList(page: Page, sessions: unknown[], options: Options = {}) {
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo(options.repoExtra)], meta: { next_cursor: null } } }),
  );
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind');
    return route.fulfill({ json: { data: kind === 'anonymous' || kind === 'devtools' ? [] : sessions } });
  });
  await page.route(/\/api\/sessions\/s\d+\/messages$/, (route) => {
    const id = /sessions\/(s\d+)\//.exec(route.request().url())?.[1] ?? '';
    return route.fulfill({ json: { data: options.messages?.[id] ?? [] } });
  });
  await page.route('**/api/agent-runs', (route) => route.fulfill({ json: { data: options.runs ?? [] } }));
  const pulls = options.pulls ?? [];
  await page.route(/\/api\/pull-requests\?repo_id=r1&state=(\w+)/, (route) => {
    const state = /state=(\w+)/.exec(route.request().url())?.[1];
    return route.fulfill({
      json: {
        data: pulls.filter((one) => one.state === state),
        meta: { synced_at: NOW, stale: false, next_cursor: null },
      },
    });
  });
}

const row = (page: Page, title: string) => page.getByRole('listitem').filter({ hasText: title });
const open = (page: Page, path = '/sessions') => page.goto(`${daemon.url}${path}#token=${daemon.token}`);

test('the list panel toggle is large enough to click, open and folded', async ({ page }) => {
  await routeList(page, [session('s1')]);
  await open(page);

  const collapse = page.getByRole('button', { name: 'Collapse the side panel' });
  const expanded = await collapse.boundingBox();
  expect(expanded?.width).toBeGreaterThanOrEqual(32);
  expect(expanded?.height).toBeGreaterThanOrEqual(32);

  await collapse.click();
  const expand = page.getByRole('button', { name: 'Open the side panel' });
  const folded = await expand.boundingBox();
  expect(folded?.width).toBeGreaterThanOrEqual(32);
  expect(folded?.height).toBeGreaterThanOrEqual(32);
});

test('a Session with unsent text shows Draft while another is open, until the text is sent or cleared; a reload keeps it', async ({
  page,
}) => {
  await routeList(page, [session('s1'), session('s2')]);
  await open(page, '/sessions?session=s1');
  const message = page.getByRole('textbox', { name: 'Message' });
  await message.fill('half-written thought');

  // Open Session: no badge on its own row. Leaving it puts the badge there.
  await expect(row(page, 'Session s1').getByText('Draft')).toHaveCount(0);
  await row(page, 'Session s2').getByRole('button').click();
  await expect(page).toHaveURL(/session=s2/);
  await expect(row(page, 'Session s1').getByText('Draft')).toBeVisible();
  await expect(row(page, 'Session s2').getByText('Draft')).toHaveCount(0);

  await page.reload();
  await expect(row(page, 'Session s1').getByText('Draft')).toBeVisible();

  // Back in s1 the badge goes, and clearing the text leaves none behind.
  await row(page, 'Session s1').getByRole('button').click();
  await expect(row(page, 'Session s1').getByText('Draft')).toHaveCount(0);
  await expect(message).toHaveText('half-written thought');
  await message.fill('');
  await row(page, 'Session s2').getByRole('button').click();
  await expect(row(page, 'Session s1').getByText('Draft')).toHaveCount(0);

  // Spaces alone are no draft.
  await row(page, 'Session s1').getByRole('button').click();
  await message.fill('   ');
  await row(page, 'Session s2').getByRole('button').click();
  await expect(row(page, 'Session s1').getByText('Draft')).toHaveCount(0);
});

test('a Session that is sent from loses its Draft badge', async ({ page }) => {
  await routeList(page, [session('s1'), session('s2')]);
  await page.route('**/api/sessions/s1/messages', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 202, json: { data: { message_id: 'm1' } } })
      : route.fallback(),
  );
  await open(page, '/sessions?session=s1');
  await page.getByRole('textbox', { name: 'Message' }).fill('go');
  await row(page, 'Session s2').getByRole('button').click();
  await expect(row(page, 'Session s1').getByText('Draft')).toBeVisible();
  await row(page, 'Session s1').getByRole('button').click();
  // Leave only once the send has been answered, so the Session is left after a finished send on a fast or a slow runner.
  const answered = page.waitForResponse((response) => response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send' }).click();
  await answered;
  await row(page, 'Session s2').getByRole('button').click();
  await expect(row(page, 'Session s1').getByText('Draft')).toHaveCount(0);
});

test('opening a Session puts the caret at the end of its draft, and typing lands there with no click', async ({
  page,
}) => {
  await routeList(page, [session('s1'), session('s2')]);
  await open(page, '/sessions');
  await page.evaluate(() =>
    localStorage.setItem('ops-console:workspace.draft.session.s2', JSON.stringify('draft so far')),
  );

  await row(page, 'Session s2').getByRole('button').click();
  const message = page.getByRole('textbox', { name: 'Message' });
  await expect(message).toBeFocused();
  await page.keyboard.type(' and more');
  await expect(message).toHaveText('draft so far and more');

  // An empty box gets the caret too.
  await row(page, 'Session s1').getByRole('button').click();
  await expect(message).toBeFocused();
  await page.keyboard.type('fresh');
  await expect(message).toHaveText('fresh');
});

test('opening a Session leaves the focus in another field alone', async ({ page }) => {
  await routeList(page, [session('s1'), session('s2')]);
  await open(page, '/sessions?session=s1');
  const search = page.getByRole('searchbox', { name: 'Search Sessions' });
  await search.focus();
  await page.evaluate(() => {
    history.pushState(null, '', '/sessions?session=s2');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: 'Session s2' })).toBeVisible();
  await expect(search).toBeFocused();
});

test('a draft that ends in a file chip keeps a line for the caret, and the caret returns after a tab switch', async ({
  page,
}) => {
  await routeList(page, [session('s1')]);
  await open(page, '/sessions');
  await page.evaluate(() =>
    localStorage.setItem('ops-console:workspace.draft.session.s1', JSON.stringify('look at @src/app.ts')),
  );
  await row(page, 'Session s1').getByRole('button').click();
  const message = page.getByRole('textbox', { name: 'Message' });
  await expect(message).toBeFocused();
  // The cursor is in the box, after the chip, and the text the agent reads has no stray line break.
  expect(await message.evaluate((node) => node.contains(document.getSelection()?.anchorNode ?? null))).toBe(true);
  await page.keyboard.type(' now');
  await expect(message).toContainText('now');

  // Back from another tab: the browser has dropped the selection, the box still holds the focus.
  await message.evaluate((node) => {
    document.getSelection()?.removeAllRanges();
    if (document.activeElement !== node) throw new Error('the box lost the focus');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await message.evaluate((node) => node.contains(document.getSelection()?.anchorNode ?? null))).toBe(true);
});

test('the pull request badge hovers on its own: one pull request on one line, several as a list, the row card closed', async ({
  page,
}) => {
  const one = [{ number: 7, url: 'https://example.com/pull/7', branch: 'b7' }];
  await page.clock.install();
  const two = [
    { number: 12, url: 'https://example.com/pull/12', branch: 'b12' },
    { number: 9, url: 'https://example.com/pull/9', branch: 'b9' },
  ];
  await routeList(page, [session('s1', { pull_requests: one }), session('s2', { pull_requests: two })], {
    pulls: [pull(7, 'Guard empty carts'), pull(12, 'Retry the webhook'), pull(9, 'Drop the old index', 'merged')],
  });
  await open(page, '/sessions');

  await row(page, 'Session s1').getByText('7', { exact: true }).hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toHaveText('#7Guard empty carts');
  // Only the pull request: no row card while the pointer is on the badge, however long it rests there.
  await page.clock.runFor(700);
  await expect(tip).toHaveCount(1);

  await row(page, 'Session s2').getByText('+2').hover();
  await expect(tip).toHaveText('#12Retry the webhook#9Drop the old index');
  await page.clock.runFor(700);
  await expect(tip).toHaveCount(1);

  // Off the badge and on the rest of the row, the row's card opens.
  await row(page, 'Session s2').getByText('Session s2', { exact: true }).hover();
  await expect(tip).toHaveCount(1);
  await expect(tip).toContainText('/work/checkout-api');
  await expect(tip).toContainText('Opus');
  await expect(tip).toContainText('#12');
});

test('the row card opens again when the pull request badge goes while the pointer is on it', async ({ page }) => {
  const one = [{ number: 7, url: 'https://example.com/pull/7', branch: 'b7' }];
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/ws', (ws) => {
    socket = ws;
  });
  await routeList(page, [session('s1', { pull_requests: one })], { pulls: [pull(7, 'Guard empty carts')] });
  await open(page, '/sessions');
  await row(page, 'Session s1').getByText('7', { exact: true }).hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toHaveText('#7Guard empty carts');

  // The list refetches with no pull request: the badge unmounts under the pointer.
  await expect.poll(() => socket !== undefined).toBe(true);
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => route.fulfill({ json: { data: [session('s1')] } }));
  socket?.send(
    JSON.stringify({
      event: 'session.updated',
      at: NOW,
      data: { session_id: 's1', title: 'Session s1', state: 'idle', account_id: null, branch: 'main' },
    }),
  );
  await expect(row(page, 'Session s1').getByText('7', { exact: true })).toHaveCount(0);

  await expect(tip).toContainText('/work/checkout-api');
});

test("the row card names the Repo's folder and warns when the Repo is checked out on another branch", async ({
  page,
}) => {
  await routeList(page, [session('s1', { branch: 'fix/cart' }), session('s2', { branch: 'main' })]);
  await open(page, '/sessions');

  await row(page, 'Session s1').getByRole('button').hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toContainText('/work/checkout-api');
  await expect(tip).toContainText('fix/cart');
  await expect(tip).toContainText("You're currently checked out on another branch.");

  await page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);
  await row(page, 'Session s2').getByRole('button').hover();
  await expect(tip).toContainText('/work/checkout-api');
  await expect(tip).not.toContainText('another branch');
});

test('a working row shows a blue spinner with seconds, then minutes; waiting on subagents shows Waiting; idle shows the bare age', async ({
  page,
}) => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const run = (id: string, startedMs: number) => ({
    session: session(id),
    running: true,
    outcome: null,
    started_at: ago(startedMs),
    finished_at: null,
    can_resume: true,
    can_retry: true,
    subagents: [],
    health: 'on_track',
    health_reason: 'On track',
    activity: null,
    cost_usd: null,
    tokens: null,
    usage: null,
    limit: null,
    split: [],
  });
  const subagent = {
    id: 'x1',
    parent_id: null,
    description: 'Explore',
    type: 'Explore',
    status: 'working',
    started_at: NOW,
    finished_at: null,
  };
  await routeList(
    page,
    [
      session('s1', { state: 'working' }),
      session('s2', { state: 'working' }),
      session('s3', { state: 'working', subagents: [subagent] }),
      session('s4', { last_active_at: ago(3 * 3_600_000) }),
      session('s5', { last_active_at: ago(2 * 86_400_000) }),
    ],
    { runs: [run('s1', 42_000), run('s2', 5 * 60_000 + 10_000), run('s3', 20_000)] },
  );
  await open(page, '/sessions');

  const seconds = row(page, 'Session s1');
  await expect(seconds).toContainText(/Working [45]\ds/);
  await expect(seconds.locator('.animate-spin')).toHaveCount(1);
  await expect(seconds.getByText(/^Working/)).toHaveClass(/text-info/);
  await expect(row(page, 'Session s2')).toContainText(/Working 5m/);

  const waiting = row(page, 'Session s3');
  await expect(waiting).toContainText(/Waiting \d+s/);
  await expect(waiting).not.toContainText('Working');
  await expect(waiting.getByText(/^Waiting/)).toHaveClass(/text-neutral-700/);
  await expect(waiting.locator('.animate-spin')).toHaveCount(1);

  await expect(row(page, 'Session s4').getByTitle(/^Started /)).toHaveText('3h');
  await expect(row(page, 'Session s5').getByTitle(/^Started /)).toHaveText('2d');
});

test('a prompt has Copy prompt link; the link carries no #, and opening it shows that message', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const filler = 'A long answer line that takes space in the conversation. '.repeat(12);
  const messages = Array.from({ length: 30 }, (_, n) =>
    n % 2 === 0 ? said(`u${n}`, 'user', `question ${n}`) : said(`a${n}`, 'agent', filler),
  );
  await routeList(page, [session('s1')], { messages: { s1: messages } });
  await open(page, '/sessions?session=s1');

  const prompt = page.getByRole('listitem', { name: 'Your message' }).filter({ hasText: 'question 8' });
  await prompt.scrollIntoViewIfNeeded();
  await prompt.hover();
  await expect(prompt.getByRole('button', { name: 'Copy prompt link' })).toHaveAttribute('title', 'Copy prompt link');
  await prompt.getByRole('button', { name: 'Copy prompt link' }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(`${daemon.url}/sessions?session=s1&message=u8`);
  expect(link).not.toContain('#');

  // The link opens the Session with that message in view, not at the end; the address then drops the message.
  await page.goto(`${link}#token=${daemon.token}`);
  const target = page.locator('li[data-message-id="u8"]');
  await expect(target).toBeInViewport();
  await expect(page.locator('li[data-message-id="a29"]')).not.toBeInViewport();
  await expect(page).toHaveURL(/\/sessions\?session=s1$/);
});
