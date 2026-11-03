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
  alert_id: null,
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
  // The search narrows the branches as it is typed.
  await page.getByRole('searchbox', { name: /Search Branch for a new Session/ }).fill('rel');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('option', { name: /^release/ }).click();
  await expect(branch).toContainText('release');

  await analytics.getByRole('button', { name: /^analytics/ }).click();
  await expect(analytics.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'apis' })).toContainText('check domain');
  await page.reload();
  await expect(page.getByRole('region', { name: 'analytics' }).getByRole('listitem')).toHaveCount(0);
});

test('Collapse all and Expand all fold every Repo; a search keeps the matching Repos and Sessions, open', async ({
  page,
}) => {
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'analytics'), repo('r2', 'apis')], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({
      json: {
        data: [
          session('s1', 'r1', 'fix login'),
          session('s2', 'r1', 'audit queries'),
          session('s3', 'r1', 'add metrics'),
          session('s4', 'r1', 'old idea'),
          session('s7', 'r2', 'check domain', 'idle', 'feature/dns'),
        ],
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);
  const analytics = page.getByRole('region', { name: 'analytics' });
  const apis = page.getByRole('region', { name: 'apis' });

  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(analytics.getByRole('listitem')).toHaveCount(0);
  await expect(apis.getByRole('listitem')).toHaveCount(0);
  await page.getByRole('button', { name: 'Expand all' }).click();
  await expect(analytics.getByRole('listitem')).toHaveCount(3);
  await expect(apis.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Collapse all' }).click();

  const search = page.getByRole('searchbox', { name: 'Search Sessions' });
  await search.fill('dns');
  await expect(analytics).toHaveCount(0);
  await expect(apis.getByRole('listitem')).toHaveText([/check domain/]);
  await search.fill('Analytics');
  await expect(apis).toHaveCount(0);
  await expect(analytics.getByRole('listitem')).toHaveCount(4);
  await expect(analytics.getByRole('button', { name: /Show \d more/ })).toHaveCount(0);
  await search.fill('nothing like it');
  await expect(page.getByText('No Repo or Session matches “nothing like it”.')).toBeVisible();
  await search.fill('');
  await expect(analytics.getByRole('listitem')).toHaveCount(0);
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

test('files picked, pasted or dropped on the message box upload, show as chips and go with the message', async ({
  page,
}) => {
  const uploads: string[] = [];
  let sent: { text: string } | null = null;
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'engage platform')] } }),
  );
  await page.route(/\/api\/sessions\/s1\/attachments/, (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    uploads.push(name);
    return route.fulfill({
      status: 201,
      json: { data: { name, path: `/data/attachments/s1/${uploads.length}.bin`, size: 2048 } },
    });
  });
  await page.route('**/api/sessions/s1/messages', (route) => {
    if (route.request().method() === 'POST') {
      sent = route.request().postDataJSON();
      return route.fulfill({ status: 202, json: { data: { message_id: 'm1' } } });
    }
    return route.fulfill({ json: { data: [] } });
  });
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const box = page.getByRole('textbox', { name: 'Message' });
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'app.log', mimeType: 'text/plain', buffer: Buffer.from('boom') });
  await box.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(['png'], 'shot.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await box.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(['{}'], 'order.json', { type: 'application/json' }));
    element.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  const chips = page.getByRole('list', { name: 'Attached files' }).getByRole('listitem');
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(1)).toContainText('2 KB');
  expect(uploads).toEqual(['app.log', 'shot.png', 'order.json']);
  await expect(box).toHaveValue('');

  await page.getByRole('button', { name: 'Remove order.json' }).click();
  await box.fill('why does this fail?');
  await box.press('Enter');
  await expect
    .poll(() => sent?.text)
    .toBe(
      'why does this fail?\n\nAttached files (open each with the Read tool):\n- app.log: /data/attachments/s1/1.bin\n- shot.png: /data/attachments/s1/2.bin',
    );
  await expect(chips).toHaveCount(0);
});

test('a Session opens at its newest message', async ({ page }) => {
  const said = (n: number) => ({
    id: `m${n}`,
    role: n % 2 === 0 ? 'user' : 'agent',
    status: 'done',
    parts: [{ kind: 'text', text: `message ${n}` }],
    created_at: NOW,
  });
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'engage platform')] } }),
  );
  await page.route('**/api/sessions/s1/messages', (route) =>
    route.fulfill({ json: { data: Array.from({ length: 40 }, (_, n) => said(n)) } }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  await expect(page.getByText('message 39', { exact: true })).toBeInViewport();
  await expect(page.getByText('message 0', { exact: true })).not.toBeInViewport();

  // The map has a mark per message, the ones in view current; a mark scrolls to its message.
  const marks = page.getByRole('navigation', { name: 'Conversation map' }).getByRole('button');
  await expect(marks).toHaveCount(40);
  await expect(marks.nth(39)).toHaveAttribute('aria-current', 'location');
  await expect(marks.nth(0)).toHaveAccessibleName('You: message 0');
  await marks.nth(0).click();
  await expect(page.getByText('message 0', { exact: true })).toBeInViewport();
  await expect(marks.nth(0)).toHaveAttribute('aria-current', 'location');
  await expect(marks.nth(39)).not.toHaveAttribute('aria-current', 'location');
});

test('a message typed while the agent works waits as Queued and sends when the run ends', async ({ page }) => {
  let state = 'working';
  const sent: string[] = [];
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'engage platform', state)] } }),
  );
  await page.route('**/api/sessions/s1/messages', (route) => {
    if (route.request().method() === 'POST') {
      sent.push(route.request().postDataJSON().text);
      return route.fulfill({ json: { data: { message_id: 'm9' } } });
    }
    return route.fulfill({ json: { data: [] } });
  });
  await page.route('**/api/sessions/s1/stop', (route) => {
    state = 'idle';
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const box = page.getByRole('textbox', { name: 'Message' });
  await expect(box).toBeEnabled();
  await box.fill('also add a test');
  await page.getByRole('button', { name: 'Queue' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Queued' })).toContainText('also add a test');
  await expect(box).toHaveValue('');
  expect(sent).toEqual([]);

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => sent).toEqual(['also add a test']);
  await expect(page.getByRole('status').filter({ hasText: 'Queued' })).toHaveCount(0);
});

test('Scroll to end shows when scrolled up and jumps to the newest message', async ({ page }) => {
  const said = (n: number) => ({
    id: `m${n}`,
    role: n % 2 === 0 ? 'user' : 'agent',
    status: 'done',
    parts: [{ kind: 'text', text: `message ${n}` }],
    created_at: NOW,
  });
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'engage platform')] } }),
  );
  await page.route('**/api/sessions/s1/messages', (route) =>
    route.fulfill({ json: { data: Array.from({ length: 40 }, (_, n) => said(n)) } }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const button = page.getByRole('button', { name: 'Scroll to end' });
  await expect(page.getByText('message 39', { exact: true })).toBeInViewport();
  await expect(button).toHaveCount(0);
  await page.getByRole('region', { name: 'Conversation' }).evaluate((node) => node.scrollTo({ top: 0 }));
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByText('message 39', { exact: true })).toBeInViewport();
  await expect(button).toHaveCount(0);
});

test('the Diff panel shows the branch the agent moved to and its files, folds them and resizes', async ({ page }) => {
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'engage platform')] } }),
  );
  await page.route('**/api/sessions/s1/messages', (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/sessions/s1/diff', (route) =>
    route.fulfill({
      json: {
        data: {
          branch: 'fix/login',
          base: 'origin/main',
          additions: 3,
          deletions: 1,
          files: [
            {
              name: 'src/auth/login.ts',
              old_name: null,
              status: 'modified',
              additions: 2,
              deletions: 1,
              binary: false,
              truncated: false,
              lines: [
                { sign: ' ', text: '@@ -1,2 +1,3 @@' },
                { sign: '-', text: 'const retries = 1;' },
                { sign: '+', text: 'const retries = 3;' },
                { sign: '+', text: 'const backoff = 200;' },
              ],
            },
            {
              name: 'notes.md',
              old_name: null,
              status: 'added',
              additions: 1,
              deletions: 0,
              binary: false,
              truncated: false,
              lines: [
                { sign: ' ', text: '@@ -0,0 +1 @@' },
                { sign: '+', text: 'why' },
              ],
            },
          ],
        },
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const header = page.locator('header', { hasText: 'engage platform' });
  // The header follows the branch checked out now, not the one the Session started on.
  await expect(header).toContainText('fix/login');
  const toggle = header.getByRole('button', { name: /^Diff/ });
  await expect(toggle).toContainText('+3 −1');
  await toggle.click();

  const panel = page.getByRole('complementary', { name: 'Diff' });
  await expect(panel).toContainText('fix/login → origin/main');
  await expect(panel.getByRole('button', { name: /, (modified|added)$/ })).toHaveCount(2);
  await expect(panel.getByText('const backoff = 200;')).toBeVisible();
  await panel.getByRole('button', { name: 'src/auth/login.ts, modified' }).click();
  await expect(panel.getByText('const backoff = 200;')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Split' }).click();
  await expect(panel.getByRole('button', { name: 'Unified' })).toBeVisible();

  const handle = page.getByRole('separator', { name: 'Resize the diff panel' });
  const before = Number(await handle.getAttribute('aria-valuenow'));
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', String(before - 32));

  // Open and width stay through a reload.
  await page.reload();
  await expect(page.getByRole('complementary', { name: 'Diff' })).toBeVisible();
  await expect(page.getByRole('separator', { name: 'Resize the diff panel' })).toHaveAttribute(
    'aria-valuenow',
    String(before - 32),
  );
  await page.getByRole('button', { name: 'Close the diff' }).click();
  await expect(page.getByRole('complementary', { name: 'Diff' })).toHaveCount(0);
});

test('a pull request the agent names in the conversation links at the top of the Session', async ({ page }) => {
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
          {
            id: 'm1',
            role: 'agent',
            status: 'done',
            parts: [{ kind: 'text', text: 'Opened https://github.com/example/apis/pull/42 for review.' }],
            created_at: NOW,
          },
        ],
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const header = page.locator('header');
  // One link opens the pull request in the Workspace, the other on the Git host.
  await expect(header.getByRole('link', { name: /^PR #42/ })).toHaveAttribute('href', /tab=pulls&pr=r1%2F42/);
  await expect(header.getByRole('link', { name: /#42 on host/ })).toHaveAttribute(
    'href',
    'https://github.com/example/apis/pull/42',
  );
});

test("the agent's tool steps fold to a count and the latest, and open as short lines", async ({ page }) => {
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

  // The run folds to one line: how many steps and the latest, not the commands.
  const toggle = page.getByRole('button', { name: 'Show 2 steps' });
  await expect(toggle).toContainText('2 steps');
  await expect(toggle).toContainText('Read scripts/platforms/engage.ts');
  await expect(page.getByRole('list', { name: 'Agent steps' })).toHaveCount(0);

  await toggle.click();
  const steps = page.getByRole('list', { name: 'Agent steps' }).getByRole('listitem');
  await expect(steps).toHaveText([/Ran ls.*done/, /Read scripts\/platforms\/engage\.ts.*in progress/]);
  await expect(steps.last()).toHaveAttribute('aria-current', 'step');
});
