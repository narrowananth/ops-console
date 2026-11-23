import { readFileSync } from 'node:fs';
import { expect, type Page, test, type WebSocketRoute } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-10-31T10:00:00.000Z';

const repo = (id: string, name: string, sessionCount = 0) => ({
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
  pr_action: null,
  connection_ids: null,
  extra_repo_ids: [],
  pull_request: null,
  pull_requests: [],
  alert_id: null,
  state,
  last_message_preview: null,
  last_error: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook: null,
  queued_message: null,
  spawned_by: null,
  spawned: [],
  subagents: [],
});

const repoRoutes = async (page: Page, repos: ReturnType<typeof repo>[], sessions: ReturnType<typeof session>[]) => {
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: repos, meta: { next_cursor: null } } }));
  await page.route(/\/api\/sessions\?kind=repo/, (route) => route.fulfill({ json: { data: sessions } }));
};

test('Sessions list by what needs you, then running, then idle; a long idle list shortens and a group folds', async ({
  page,
}) => {
  const idle = Array.from({ length: 9 }, (_, n) => session(`i${n}`, 'r1', `idle job ${n}`));
  await repoRoutes(
    page,
    [repo('r1', 'analytics'), repo('r2', 'apis'), repo('r3', 'artifacts')],
    [
      session('w1', 'r1', 'approve the push', 'waiting_approval'),
      session('s5', 'r1', 'long job', 'working', 'feature/jobs'),
      ...idle,
      session('s7', 'r2', 'check domain'),
    ],
  );
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);

  const needs = page.getByRole('region', { name: 'Needs you' });
  const running = page.getByRole('region', { name: 'Running' });
  const idleGroup = page.getByRole('region', { name: 'Idle' });
  await expect(needs.getByRole('listitem')).toHaveText([/approve the push.*approval.*analytics/]);
  await expect(running.getByRole('listitem')).toHaveText([/long job.*analytics.*feature\/jobs/]);
  // Eight idle Sessions show; the other two wait behind "Show 2 more". Artifacts has none and does not appear.
  await expect(idleGroup.getByRole('listitem')).toHaveCount(9);
  await expect(page.getByText('artifacts')).toHaveCount(0);
  await idleGroup.getByRole('button', { name: 'Show 2 more' }).click();
  await expect(idleGroup.getByRole('listitem')).toHaveCount(11);
  await idleGroup.getByRole('button', { name: 'Show fewer' }).click();
  await expect(idleGroup.getByRole('listitem')).toHaveCount(9);

  // A folded group keeps its header and count, and stays folded through a reload.
  await page.getByRole('button', { name: 'Fold Idle' }).click();
  await expect(idleGroup.getByRole('listitem')).toHaveCount(0);
  await expect(idleGroup).toContainText('10');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Fold Idle' })).toHaveAttribute('aria-expanded', 'false');
  await expect(running.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Fold Idle' }).click();
  await expect(idleGroup.getByRole('listitem')).toHaveCount(9);
});

test('+ New picks a Repo and a branch, or no Repo, and starts a Session there', async ({ page }) => {
  await repoRoutes(page, [repo('r1', 'analytics'), repo('r2', 'apis')], [session('s1', 'r2', 'check domain')]);
  await page.route('**/api/repos/*/branches', (route) =>
    route.fulfill({
      json: {
        data: [
          { name: 'main', current: true, remote: false, has_open_pr: false },
          { name: 'release', current: false, remote: false, has_open_pr: true },
        ],
      },
    }),
  );
  const started: unknown[] = [];
  await page.route('**/api/sessions', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    started.push(route.request().postDataJSON());
    return route.fulfill({ json: { data: session('s9', 'r1', 'new one', 'idle', 'release') } });
  });
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);

  const branch = page.getByRole('button', { name: 'Branch for a new Session in analytics' });
  await expect(branch).toHaveCount(0);
  await page.getByRole('button', { name: '+ New' }).click();
  await branch.click();
  await expect(page.getByRole('option', { name: /^main/ })).toContainText('checked out');
  // The search narrows the branches as it is typed.
  await page.getByRole('searchbox', { name: /Search Branch for a new Session/ }).fill('rel');
  // The one branch that matches, and the offer to make a branch of that name.
  await expect(page.getByRole('option')).toHaveCount(2);
  await expect(page.getByRole('option', { name: /^Create rel/ })).toBeVisible();
  await page.getByRole('option', { name: /^release/ }).click();
  await expect(branch).toContainText('release');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => started).toEqual([{ repo_id: 'r1', branch: 'release' }]);

  // With no Repo there is no branch to pick.
  await page.getByRole('button', { name: '+ New' }).click();
  await page.getByRole('button', { name: 'Repo for a new Session' }).click();
  await page.getByRole('option', { name: /^No Repo/ }).click();
  await expect(page.getByRole('button', { name: /^Branch for a new Session/ })).toHaveCount(0);
});

test('+ New starts on a branch only origin has, or on a new branch typed into the list', async ({ page }) => {
  await repoRoutes(page, [repo('r1', 'analytics')], []);
  await page.route('**/api/repos/*/branches', (route) =>
    route.fulfill({
      json: {
        data: [
          { name: 'main', current: true, remote: false, has_open_pr: false },
          { name: 'teammate-fix', current: false, remote: true, has_open_pr: false },
        ],
      },
    }),
  );
  const started: unknown[] = [];
  await page.route('**/api/sessions', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    started.push(route.request().postDataJSON());
    return route.fulfill({ json: { data: session('s9', 'r1', 'new one', 'idle', 'main') } });
  });
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);

  const branch = page.getByRole('button', { name: 'Branch for a new Session in analytics' });
  await page.getByRole('button', { name: '+ New' }).click();
  await branch.click();
  await expect(page.getByRole('option', { name: /^teammate-fix/ })).toContainText('on origin');
  await page.getByRole('option', { name: /^teammate-fix/ }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => started).toEqual([{ repo_id: 'r1', branch: 'teammate-fix', from_origin: true }]);

  await page.getByRole('button', { name: '+ New' }).click();
  await branch.click();
  await page.getByRole('searchbox', { name: /Search Branch for a new Session/ }).fill('brand-new');
  await page.getByRole('option', { name: /Create brand-new/ }).click();
  await expect(branch).toContainText('brand-new');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => started.at(-1)).toEqual({ repo_id: 'r1', branch: 'brand-new', new_branch: true });
});

test('the state chips, the Repo filter and a search narrow the list; a search matches Repo, branch and title', async ({
  page,
}) => {
  await repoRoutes(
    page,
    [repo('r1', 'analytics'), repo('r2', 'apis')],
    [
      session('s1', 'r1', 'fix login'),
      session('s2', 'r1', 'audit queries', 'waiting_input'),
      session('s3', 'r1', 'long job', 'working'),
      session('s7', 'r2', 'check domain', 'idle', 'feature/dns'),
    ],
  );
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);
  const list = page.locator('aside').filter({ has: page.getByRole('tablist', { name: 'Workspace' }) });

  const states = list.getByRole('group', { name: 'Session state' });
  await expect(states.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await states.getByRole('button', { name: 'Needs you 1' }).click();
  await expect(list.getByRole('listitem')).toHaveText([/audit queries/]);
  await states.getByRole('button', { name: 'Running 1' }).click();
  await expect(list.getByRole('listitem')).toHaveText([/long job/]);
  await states.getByRole('button', { name: 'All', exact: true }).click();

  await list.getByRole('button', { name: /Filter by Repo/ }).click();
  await page.getByRole('option', { name: /^apis/ }).click();
  await expect(list.getByRole('listitem')).toHaveText([/check domain/]);
  await list.getByRole('button', { name: /Filter by Repo/ }).click();
  await page.getByRole('option', { name: /^All Repos/ }).click();
  await expect(list.getByRole('listitem')).toHaveCount(4);

  const search = page.getByRole('searchbox', { name: 'Search Sessions' });
  await search.fill('dns');
  await expect(list.getByRole('listitem')).toHaveText([/check domain/]);
  await search.fill('Analytics');
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await search.fill('nothing like it');
  await expect(page.getByText('No Session matches “nothing like it”.')).toBeVisible();
  await search.fill('');
  await expect(list.getByRole('listitem')).toHaveCount(4);
});

test('the tabs and search stay in view while the Sessions list scrolls', async ({ page }) => {
  const sessions = Array.from({ length: 30 }, (_, n) => session(`s${n}`, 'r1', `job ${n}`));
  await page.setViewportSize({ width: 1280, height: 600 });
  await repoRoutes(page, [repo('r1', 'analytics')], sessions);
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);
  const search = page.getByRole('searchbox', { name: 'Search Sessions' });
  const tabs = page.getByRole('tablist', { name: 'Workspace' });
  await page.getByRole('button', { name: 'Show 22 more' }).click();
  await expect(page.getByText('job 29', { exact: true })).toHaveCount(1);

  await page.getByText('job 29', { exact: true }).scrollIntoViewIfNeeded();
  await expect(tabs).toBeInViewport();
  await expect(search).toBeInViewport();
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

  const card = page.getByRole('complementary', { name: 'Session' });
  await expect(card.getByRole('button', { name: 'Delete' })).toBeDisabled();
  // The Session's row in the list stops it too, from its hover.
  await expect(page.getByRole('button', { name: 'Stop GET /v3/products failing' })).toBeAttached();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => stops).toEqual(['POST']);
  await expect(page.getByRole('button', { name: /^Stop/ })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Delete' })).toBeEnabled();
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

test('files picked, pasted or dropped on the message box upload, show as chips above it and go with the message', async ({
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
      json: {
        data: {
          name,
          path: `/data/attachments/s1/${uploads.length}.bin`,
          size: 2048,
          type: TYPE_OF[name] ?? 'text/plain',
        },
      },
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
  // Each file is a chip in the row above the text, in the order it was added.
  const row = page.getByRole('list', { name: 'Files to send' });
  const chip = (name: string) => row.locator(`[data-file="${name}"]`);
  await expect(row.getByRole('listitem')).toHaveCount(3);
  await expect(chip('app.log')).toContainText('2 KB');
  await expect(chip('shot.png')).toBeVisible();
  await expect(chip('order.json')).toBeVisible();
  await expect(box.locator('[data-file]')).toHaveCount(0);
  expect(uploads).toEqual(['app.log', 'shot.png', 'order.json']);

  // Files stay with the Session through a reload.
  await page.reload();
  await expect(chip('app.log')).toContainText('2 KB');

  await chip('order.json').getByRole('button', { name: 'Remove order.json' }).click();
  await expect(chip('order.json')).toHaveCount(0);
  await box.click();
  await box.pressSequentially('why does this fail?');
  await box.press('Enter');
  await expect
    .poll(() => sent?.text)
    .toBe(
      'why does this fail?\n\nAttached files (open each with the Read tool):\n- app.log: /data/attachments/s1/1.bin (text/plain, 2 KB)\n- shot.png: /data/attachments/s1/2.bin (image/png, 2 KB)',
    );
  await expect(row).toHaveCount(0);
});

const TYPE_OF: Record<string, string> = {
  'shot.png': 'image/png',
  'clip.mp4': 'video/mp4',
  'voice.mp3': 'audio/mpeg',
  'report.pdf': 'application/pdf',
  'plan.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'data.csv': 'text/csv',
  'bundle.zip': 'application/zip',
  'blob.xyz': 'application/octet-stream',
};

test('every kind of file attaches as its own chip; a file that fails or is empty leaves the others alone', async ({
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
  await page.route(/\/api\/sessions\/s1\/attachments\?/, (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    uploads.push(name);
    if (name === 'bad.log') {
      return route.fulfill({
        status: 500,
        json: { error: { code: 'internal', message: 'The data folder is full' } },
      });
    }
    return route.fulfill({
      status: 201,
      json: { data: { name, path: `/data/attachments/s1/${uploads.length}.bin`, size: 3000, type: TYPE_OF[name] } },
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

  const kinds: [string, string][] = [
    ['shot.png', 'image'],
    ['clip.mp4', 'video'],
    ['voice.mp3', 'audio'],
    ['report.pdf', 'document'],
    ['plan.docx', 'document'],
    ['data.csv', 'text'],
    ['bundle.zip', 'archive'],
    ['blob.xyz', 'file'],
  ];
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.locator('input[type=file]').setInputFiles([
    ...kinds.map(([name]) => ({
      name,
      mimeType: TYPE_OF[name] ?? 'application/octet-stream',
      buffer: name === 'shot.png' ? png : Buffer.from('bytes'),
    })),
    { name: 'bad.log', mimeType: 'text/plain', buffer: Buffer.from('boom') },
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
  ]);

  const row = page.getByRole('list', { name: 'Files to send' });
  for (const [name, kind] of kinds) {
    const chip = row.locator(`[data-file="${name}"]`);
    await expect(chip).toHaveAttribute('data-kind', kind);
    await expect(chip).toContainText('3 KB');
    await expect(chip.getByRole('button', { name: `Remove ${name}` })).toBeVisible();
  }
  // The image shows its own picture.
  await expect(row.locator('[data-file="shot.png"] img')).toBeVisible();
  // A failed upload says why in its chip, an empty file is refused without going to the daemon.
  await expect(row.locator('[data-file="bad.log"]')).toContainText('The data folder is full');
  await expect(row.locator('[data-file="empty.txt"]')).toContainText('empty');
  expect(uploads).not.toContain('empty.txt');

  await row.locator('[data-file="bad.log"]').getByRole('button', { name: 'Remove bad.log' }).click();
  await row.locator('[data-file="empty.txt"]').getByRole('button', { name: 'Remove empty.txt' }).click();
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('read these');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => sent?.text)
    .toBe(
      [
        'read these',
        '',
        'Attached files (open each with the Read tool):',
        '- shot.png: /data/attachments/s1/1.bin (image/png, 3 KB)',
        '- clip.mp4: /data/attachments/s1/2.bin (video/mp4, 3 KB)',
        '- voice.mp3: /data/attachments/s1/3.bin (audio/mpeg, 3 KB)',
        '- report.pdf: /data/attachments/s1/4.bin (application/pdf, 3 KB)',
        '- plan.docx: /data/attachments/s1/5.bin (application/vnd.openxmlformats-officedocument.wordprocessingml.document, 3 KB)',
        '- data.csv: /data/attachments/s1/6.bin (text/csv, 3 KB)',
        '- bundle.zip: /data/attachments/s1/7.bin (application/zip, 3 KB)',
        '- blob.xyz: /data/attachments/s1/8.bin (application/octet-stream, 3 KB)',
      ].join('\n'),
    );
});

test('a sent message shows its attached files as chips with their size', async ({ page }) => {
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
            role: 'user',
            status: 'done',
            created_at: NOW,
            parts: [
              {
                kind: 'text',
                text: 'read these\n\nAttached files (open each with the Read tool):\n- clip.mp4: /data/attachments/s1/a.mp4 (video/mp4, 3 KB)\n- report.pdf: /data/attachments/s1/b.pdf (application/pdf, 1.2 MB)',
              },
            ],
          },
        ],
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);
  const files = page.getByRole('listitem', { name: 'Your message' }).getByRole('list', { name: 'Attached files' });
  await expect(files.getByRole('listitem')).toHaveCount(2);
  await expect(files.locator('[data-file="clip.mp4"]')).toContainText('3 KB');
  await expect(files.locator('[data-file="clip.mp4"]')).toHaveAttribute('data-kind', 'video');
  await expect(files.locator('[data-file="report.pdf"]')).toContainText('1.2 MB');
});

test('a long paste attaches as a .txt file, typing goes on, and a paste scrolls to its end', async ({ page }) => {
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'engage platform')] } }),
  );
  await page.route(/\/api\/sessions\/s1\/attachments\?/, (route) => {
    const name = new URL(route.request().url()).searchParams.get('name') ?? '';
    return route.fulfill({ status: 201, json: { data: { name, path: '/data/attachments/s1/1.txt', size: 60000 } } });
  });
  await page.route('**/api/sessions/s1/messages', (route) => route.fulfill({ json: { data: [] } }));
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const box = page.getByRole('textbox', { name: 'Message' });
  const paste = (text: string) =>
    box.evaluate((element, value) => {
      element.focus();
      const data = new DataTransfer();
      data.setData('text/plain', value);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);

  // Past the limit the text is not drawn: it is a file, shown as a chip the operator can open.
  await paste('line of log\n'.repeat(5000));
  await expect(page.locator('[data-file="pasted-text.txt"]')).toBeVisible();
  // Only the card's first lines are in the box, not the 60,000 characters.
  expect(await box.evaluate((element) => element.textContent?.length ?? 0)).toBeLessThan(300);
  // The card shows the first lines, a PASTED badge and the size.
  await expect(page.locator('[data-file="pasted-text.txt"]')).toContainText('line of log line of log');
  await expect(page.locator('[data-file="pasted-text.txt"]')).toContainText('Pasted');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();

  // Within the limit it is text, and the box scrolls to the cursor after it.
  await box.evaluate((element) => element.replaceChildren());
  await box.evaluate((element) => element.dispatchEvent(new Event('input', { bubbles: true })));
  await paste(
    Array.from({ length: 800 }, (_, n) => `row ${n}`)
      .join('\n')
      .slice(0, 2900),
  );
  await expect.poll(() => box.evaluate((element) => element.scrollTop > 0)).toBe(true);
  expect(await box.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(
    24,
  );

  // Typing goes on after a paste: more text, and a second long paste, never block the Send.
  await paste('x'.repeat(2900));
  await paste('y'.repeat(3100));
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('a pasted text card edits in a dialog, saves under the same name, and clears', async ({ page }) => {
  const uploads: string[] = [];
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'engage platform')] } }),
  );
  await page.route(/\/api\/sessions\/s1\/attachments\?/, (route) => {
    uploads.push(new URL(route.request().url()).searchParams.get('name') ?? '');
    return route.fulfill({
      status: 201,
      json: { data: { name: 'x', path: '/data/attachments/s1/1.txt', size: 4000 } },
    });
  });
  await page.route('**/api/sessions/s1/messages', (route) => route.fulfill({ json: { data: [] } }));
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const box = page.getByRole('textbox', { name: 'Message' });
  await box.evaluate((element) => {
    element.focus();
    const data = new DataTransfer();
    data.setData('text/plain', 'old text '.repeat(500));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const card = page.locator('[data-file="pasted-text.txt"]');
  await expect(card).toContainText('Pasted');
  await card.getByRole('button', { name: 'Edit pasted-text.txt' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit pasted-text.txt' });
  await dialog.getByRole('textbox').fill('new text');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toContainText('new text');
  expect(uploads).toEqual(['pasted-text.txt', 'pasted-text.txt']);

  await card.getByRole('button', { name: 'Edit pasted-text.txt' }).click();
  await dialog.getByRole('button', { name: 'Clear' }).click();
  await expect(card).toHaveCount(0);
  // The corner × clears it too.
  await box.evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'again '.repeat(700));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await card.getByRole('button', { name: 'Remove pasted-text.txt' }).click();
  await expect(card).toHaveCount(0);
});

test('a file chip opens the file over the page, in the message box and in the conversation', async ({ page }) => {
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
            role: 'user',
            status: 'done',
            created_at: NOW,
            parts: [
              {
                kind: 'text',
                text: 'see [📎 trace.log] here\n\nAttached files (open each with the Read tool):\n- trace.log: /data/attachments/s1/abc.log',
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route('**/api/sessions/s1/diff', (route) =>
    route.fulfill({ json: { data: { branch: 'main', base: 'origin/main', additions: 0, deletions: 0, files: [] } } }),
  );
  await page.route('**/api/sessions/s1/attachments/abc.log', (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: 'TypeError: boom' }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const message = page.getByRole('listitem', { name: 'Your message' });
  await expect(message).toContainText('see');
  // A branch that changes nothing has no Diff button.
  await expect(page.getByRole('button', { name: /^Diff/ })).toHaveCount(0);
  await message.getByRole('button', { name: 'trace.log' }).click();
  const viewer = page.getByRole('dialog', { name: 'trace.log' });
  await expect(viewer).toContainText('TypeError: boom');
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toHaveCount(0);

  const box = page.getByRole('textbox', { name: 'Message' });
  await box.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(['hello there'], 'note.txt', { type: 'text/plain' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.locator('[data-file="note.txt"] button').first().click();
  await expect(page.getByRole('dialog', { name: 'note.txt' })).toContainText('hello there');
});

test('the Repos icon beside Attach opens other Repos to the Session, A to Z, without its own Repo', async ({
  page,
}) => {
  await page.route('**/api/repos', (route) =>
    route.fulfill({
      json: {
        data: [repo('r1', 'apis', 1), repo('r2', 'admin-panel'), repo('r3', 'artemis')],
        meta: { next_cursor: null },
      },
    }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'engage platform')] } }),
  );
  await page.route('**/api/sessions/s1/messages', (route) => route.fulfill({ json: { data: [] } }));
  const patches: unknown[] = [];
  await page.route('**/api/sessions/s1', (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body = route.request().postDataJSON();
    patches.push(body);
    return route.fulfill({ json: { data: { ...session('s1', 'r1', 'engage platform'), ...body } } });
  });
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const chip = page.getByRole('button', { name: /^Repos:/ });
  await expect(chip).toHaveAccessibleName('Repos: this one');
  // The icon sits in the toolbar beside Attach; no row under the message box carries a Repos label.
  const toolbar = page.getByRole('button', { name: 'Attach files' }).locator('xpath=..');
  await expect(toolbar.getByRole('button', { name: /^Repos:/ })).toBeVisible();
  const box = page
    .getByRole('textbox', { name: 'Message' })
    .locator('xpath=ancestor::div[contains(@class,"rounded-3xl")][1]');
  await expect(box.locator('xpath=following-sibling::*')).toHaveCount(0);
  await chip.click();
  const picker = page.locator('[data-extra-repos]');
  const names = picker.getByRole('button', { pressed: false }).filter({ hasText: /^(admin-panel|artemis|apis)/ });
  await expect(names).toHaveText([/^admin-panel/, /^artemis/]);
  await picker.getByRole('button', { name: /^admin-panel/ }).click();
  await expect.poll(() => patches).toEqual([{ extra_repo_ids: ['r2'] }]);
  await expect(chip).toHaveAccessibleName('Repos: this one, admin-panel');
  await expect(chip).toContainText('1');
  await picker.getByRole('button', { name: /^admin-panel/ }).click();
  await expect.poll(() => patches.at(-1)).toEqual({ extra_repo_ids: [] });
  await expect(chip).toHaveAccessibleName('Repos: this one');
});

/** A Session whose PATCHes the test reads; the reply is the Session with the change applied. */
async function routePatches(page: Page): Promise<unknown[]> {
  await repoRoutes(page, [repo('r1', 'apis', 1), repo('r2', 'admin-panel')], [session('s1', 'r1', 'engage platform')]);
  await page.route('**/api/sessions/s1/messages', (route) => route.fulfill({ json: { data: [] } }));
  const patches: unknown[] = [];
  let current = session('s1', 'r1', 'engage platform');
  await page.route('**/api/sessions/s1', (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body = route.request().postDataJSON();
    patches.push(body);
    current = { ...current, ...body };
    return route.fulfill({ json: { data: current } });
  });
  return patches;
}

test('one pill holds Model, Effort and Access, and no row under the message box is left', async ({ page }) => {
  const patches = await routePatches(page);
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const pill = page.getByRole('button', { name: 'Model, effort and access' });
  await expect(pill).toHaveText('Opus 5.5 Medium');
  // The toolbar's controls are 36 to 40 px, and the pill's text 14 px.
  const side = async (name: string | RegExp) => (await page.getByRole('button', { name }).boundingBox())?.width ?? 0;
  expect(await side('Attach files')).toBeGreaterThanOrEqual(36);
  expect(await side(/^Repos:/)).toBeGreaterThanOrEqual(36);
  expect(await pill.boundingBox().then((box) => box?.height ?? 0)).toBeGreaterThanOrEqual(36);
  expect(await pill.evaluate((node) => getComputedStyle(node).fontSize)).toBe('14px');
  await page.getByRole('textbox', { name: 'Message' }).fill('hi');
  expect(await side('Send')).toBeGreaterThanOrEqual(40);
  await expect(page.getByRole('button', { name: /^Access/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Effort', exact: true })).toHaveCount(0);

  await pill.click();
  const popover = page.getByRole('dialog', { name: 'Model, effort and access' });
  const search = popover.getByRole('searchbox', { name: 'Search models' });
  await expect(search).toBeFocused();
  await search.fill('son');
  await expect(popover.getByRole('option')).toHaveText([/Sonnet 5\.5/]);
  await search.press('Enter');
  await expect.poll(() => patches).toEqual([{ model: 'claude-sonnet-5-5' }]);
  await expect(pill).toHaveText('Sonnet 5.5 Medium');

  await search.fill('');
  await expect(popover.getByRole('option')).toHaveText([/Opus/, /Sonnet/, /Haiku/, /Fable/]);
  await popover.getByRole('radiogroup', { name: 'Reasoning' }).getByRole('radio', { name: 'Low' }).click();
  await expect.poll(() => patches.at(-1)).toEqual({ effort: 'low' });
  await expect(pill).toHaveText('Sonnet 5.5 Low');

  // Access: the footer chip names the mode and opens four icon buttons, least trust first, with the mode's words.
  const chip = popover.getByRole('button', { name: /^Access/ });
  await expect(chip).toContainText('Auto');
  await chip.click();
  const modes = popover.getByRole('radiogroup', { name: 'Access' });
  const radios = modes.getByRole('radio');
  await expect(radios).toHaveCount(4);
  for (const [at, name] of ['Supervised', 'Auto-accept edits', 'Auto', 'Full access'].entries()) {
    await expect(radios.nth(at)).toHaveAccessibleName(name);
  }
  await expect(popover).toContainText('Runs edits and safe commands; asks for risky ones');
  await radios.nth(3).click();
  await expect.poll(() => patches.at(-1)).toEqual({ access_mode: 'full' });
  await expect(popover).toContainText('Edits and runs commands without asking');
  await expect(chip).toContainText('Full access');
});

test('the Model popover works from the keyboard and gives the focus back', async ({ page }) => {
  const patches = await routePatches(page);
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const pill = page.getByRole('button', { name: 'Model, effort and access' });
  await pill.focus();
  await page.keyboard.press('Enter');
  const popover = page.getByRole('dialog', { name: 'Model, effort and access' });
  await expect(popover).toBeVisible();
  // Typing narrows the models, Enter picks the first match.
  await page.keyboard.type('fab');
  await expect(popover.getByRole('option')).toHaveText([/^Fable 5\.1/]);
  await page.keyboard.press('Enter');
  await expect.poll(() => patches).toEqual([{ model: 'claude-fable-5-1' }]);
  // Down arrows leave the search box and walk the list.
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(() => patches.at(-1)).toEqual({ model: 'claude-haiku-5-5' });
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(pill).toBeFocused();
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

/** A daemon that keeps the queued message as the real one does: Stop holds it, Send now stops a run and sends it. */
async function routeQueue(page: Page) {
  const daemonState: { state: string; queued: string | null; sent: string[]; stops: number } = {
    state: 'working',
    queued: null,
    sent: [],
    stops: 0,
  };
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({
      json: {
        data: [
          {
            ...session('s1', 'r1', 'engage platform', daemonState.state),
            queued_message: daemonState.queued,
          },
        ],
      },
    }),
  );
  await page.route('**/api/sessions/s1/messages', (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/sessions/s1/queue', (route) => {
    const method = route.request().method();
    if (method === 'PUT') {
      daemonState.queued = route.request().postDataJSON().text;
      return route.fulfill({ json: { data: { queued: true } } });
    }
    daemonState.queued = null;
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/sessions/s1/stop', (route) => {
    daemonState.state = 'idle';
    daemonState.stops++;
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/sessions/s1/queue/send', (route) => {
    if (daemonState.queued !== null) daemonState.sent.push(daemonState.queued);
    daemonState.queued = null;
    daemonState.state = 'working';
    return route.fulfill({ status: 204 });
  });
  return daemonState;
}

test('a queued message waits through Stop, and Send now sends it', async ({ page }) => {
  const daemonState = await routeQueue(page);
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const box = page.getByRole('textbox', { name: 'Message' });
  await expect(box).toBeEnabled();
  await box.fill('also add a test');
  await page.getByRole('button', { name: 'Queue' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Queued' })).toContainText('also add a test');
  await expect(box).toHaveText('');
  expect(daemonState.sent).toEqual([]);

  // Stop ends the run and holds the message: stopping must not start the next run by itself.
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'On hold' })).toContainText('also add a test');
  await page.waitForTimeout(500);
  expect(daemonState.sent).toEqual([]);

  await page.getByRole('button', { name: 'Send now' }).click();
  await expect.poll(() => daemonState.sent).toEqual(['also add a test']);
  await expect(page.getByRole('status').filter({ hasText: 'On hold' })).toHaveCount(0);
});

test('Send now sends the queued message of a run that is going, and Take back puts it in the box', async ({ page }) => {
  const daemonState = await routeQueue(page);
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('do it now');
  await page.getByRole('button', { name: 'Queue' }).click();
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect.poll(() => daemonState.sent).toEqual(['do it now']);

  daemonState.state = 'working';
  await box.fill('never mind this');
  await page.getByRole('button', { name: 'Queue' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Queued' })).toContainText('never mind this');
  await page.getByRole('button', { name: 'Take back' }).click();
  await expect(box).toHaveText('never mind this');
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

test("the Diff panel shows the Session's branch and its files, folds them and resizes", async ({ page }) => {
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'engage platform', 'idle', 'fix/login')] } }),
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

  // The Session card follows the branch checked out now, not the one the Session started on.
  await expect(page.getByRole('complementary', { name: 'Session' })).toContainText('fix/login');
  const toggle = page.getByRole('complementary', { name: 'Session' }).getByRole('button', { name: /^Changes/ });
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

test("a Session links the pull request it opened, and shows none that another Session's conversation names", async ({
  page,
}) => {
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  const opened = {
    ...session('s1', 'r1', 'engage platform', 'idle', 'fix/engage'),
    pull_request: { number: 42, url: 'https://github.com/example/apis/pull/42' },
  };
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [opened, session('s2', 'r1', 'fresh start', 'idle', 'main')] } }),
  );
  const naming = (text: string) => ({
    json: {
      data: [{ id: 'm1', role: 'agent', status: 'done', parts: [{ kind: 'text', text }], created_at: NOW }],
    },
  });
  await page.route('**/api/sessions/s1/messages', (route) =>
    route.fulfill(naming('Also see https://github.com/example/apis/pull/99 for the earlier attempt.')),
  );
  await page.route('**/api/sessions/s2/messages', (route) =>
    route.fulfill(naming('Opened https://github.com/example/apis/pull/42 for review.')),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const header = page.getByRole('complementary', { name: 'Session' });
  // One link opens the pull request in the Workspace, the other on the Git host: the Session's own, not #99.
  await expect(header.getByRole('link', { name: /^PR #42/ })).toHaveAttribute('href', /tab=pulls&pr=r1%2F42/);
  await expect(header.getByRole('link', { name: /#42 on host/ })).toHaveAttribute(
    'href',
    'https://github.com/example/apis/pull/42',
  );
  await expect(header.getByRole('link', { name: /#99/ })).toHaveCount(0);

  // A new Session on the default branch shows no pull request, whatever its conversation names.
  await page.goto(`${daemon.url}/workspace?session=s2#token=${daemon.token}`);
  await expect(page.locator('header').getByRole('heading', { name: 'fresh start' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Session' }).getByRole('link', { name: /^PR #/ })).toHaveCount(
    0,
  );
});

test('a Session that has edited nothing shows no Diff button or panel, even while the panel is open for another', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('ops-console:workspace.session-diff-open', 'true'));
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'fresh start', 'idle', 'main')] } }),
  );
  await page.route('**/api/sessions/s1/messages', (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/sessions/s1/diff', (route) =>
    route.fulfill({ json: { data: { branch: 'main', base: null, additions: 0, deletions: 0, files: [] } } }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  await expect(page.locator('header').getByRole('heading', { name: 'fresh start' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Diff/ })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Diff' })).toHaveCount(0);
});

test('a Session row keeps its Repo chip and state apart, even for a long Repo name', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await repoRoutes(
    page,
    [repo('r1', 'shopify-fraud-orders-lambda-with-a-very-long-name', 1)],
    [session('s1', 'r1', 'engage platform', 'waiting_input')],
  );
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);

  const row = page.getByRole('region', { name: 'Needs you' }).getByRole('listitem');
  const chip = row.getByText(/shopify-fraud/);
  const state = row.getByText('question', { exact: true });
  await expect(chip).toBeVisible();
  await expect(state).toBeVisible();
  const [a, b] = [await chip.boundingBox(), await state.boundingBox()];
  expect((a?.x ?? 0) + (a?.width ?? 0)).toBeLessThanOrEqual(b?.x ?? 0);
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

test('a file the agent writes or edits is one collapsed row that opens to its diff', async ({ page }) => {
  const path = '/tmp/oc-data/session/dashboard.html';
  const body = Array.from({ length: 60 }, (_, line) => `<p>generated line ${line}</p>`).join('\n');
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'dashboard', 'idle')] } }),
  );
  await page.route('**/api/sessions/s1/messages', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'a1',
            role: 'agent',
            status: 'done',
            parts: [
              { kind: 'text', text: 'Writing the page.' },
              { kind: 'diff', file: path, lines: body.split('\n').map((text) => ({ sign: '+', text })) },
              {
                kind: 'diff',
                file: '/work/apis/src/server.ts',
                lines: [
                  { sign: '-', text: 'const port = 3000;' },
                  { sign: '+', text: 'const port = 4000;' },
                ],
              },
              {
                kind: 'diff',
                file: `/work/apis/src/${'deeply-nested-'.repeat(12)}component.test.tsx`,
                lines: [{ sign: '+', text: 'x' }],
              },
            ],
            created_at: NOW,
          },
        ],
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  const created = page.getByRole('button', { name: /dashboard\.html/ });
  const edited = page.getByRole('button', { name: /server\.ts/ });
  // Collapsed: file name, verb and counts, none of the code, and no diff in the page.
  await expect(created).toHaveAttribute('aria-expanded', 'false');
  await expect(created).toContainText('Wrote');
  await expect(created).toContainText('+60');
  await expect(created).toContainText('−0');
  await expect(created.getByTitle(path)).toBeVisible();
  await expect(edited).toContainText('Edited');
  await expect(edited).toContainText('+1');
  await expect(edited).toContainText('−1');
  await expect(page.getByText('generated line 7')).toHaveCount(0);
  await expect(page.getByText('const port = 3000;')).toHaveCount(0);
  // Consecutive file changes stay consecutive rows.
  const rows = page.getByRole('button', { name: /dashboard\.html|server\.ts|component\.test\.tsx/ });
  await expect(rows).toHaveCount(3);
  // A long name shortens in the middle and keeps its ending; the row never grows past its message.
  const long = rows.last();
  await expect(long).toContainText('component.test.tsx');
  expect(await long.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0);

  await created.click();
  await expect(created).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('generated line 7')).toBeVisible();
  await expect(page.getByText('const port = 3000;')).toHaveCount(0);
  const controls = await created.getAttribute('aria-controls');
  expect(controls).toBeTruthy();
  await expect(page.locator(`[id="${controls}"]`)).toContainText('generated line 59');

  await created.click();
  await expect(created).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('generated line 7')).toHaveCount(0);

  // The keyboard opens and closes a row too.
  await edited.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('const port = 3000;')).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByText('const port = 3000;')).toHaveCount(0);
});

test('an open file row stays open while the message streams on', async ({ page }) => {
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket('**/ws', (ws) => {
    socket = ws;
  });
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 1)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({ json: { data: [session('s1', 'r1', 'dashboard', 'working')] } }),
  );
  await page.route('**/api/sessions/s1/messages', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'a1',
            role: 'agent',
            status: 'streaming',
            parts: [{ kind: 'diff', file: '/work/apis/src/a.ts', lines: [{ sign: '+', text: 'export const a = 1;' }] }],
            created_at: NOW,
          },
        ],
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);
  await page.getByRole('button', { name: /a\.ts/ }).click();
  await expect(page.getByText('export const a = 1;')).toBeVisible();
  await expect.poll(() => socket !== undefined).toBe(true);
  socket?.send(
    JSON.stringify({
      event: 'session.output',
      at: new Date().toISOString(),
      data: {
        session_id: 's1',
        message_id: 'a1',
        part_index: 1,
        part: { kind: 'diff', file: '/work/apis/src/b.ts', lines: [{ sign: '+', text: 'export const b = 2;' }] },
      },
    }),
  );
  await expect(page.getByRole('button', { name: /b\.ts/ })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: /a\.ts/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('export const a = 1;')).toBeVisible();
  await expect(page.getByText('export const b = 2;')).toHaveCount(0);
});

test('the side panel collapses to a rail that counts Sessions waiting on you, and opens on a tab', async ({ page }) => {
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'analytics', 2)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({
      json: {
        data: [session('s1', 'r1', 'fix login', 'waiting_input'), session('s2', 'r1', 'audit queries')],
        meta: { next_cursor: null },
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);

  await expect(page.getByRole('region', { name: 'Needs you' })).toContainText('fix login');
  await page.getByRole('button', { name: 'Collapse the side panel' }).click();
  await expect(page.getByRole('tablist', { name: 'Workspace' })).toHaveCount(0);
  const rail = page.getByRole('navigation', { name: 'Workspace panel' });
  await expect(rail.getByRole('button', { name: 'Sessions, 1 waiting on you' })).toBeVisible();

  // Folded stays folded through a reload.
  await page.reload();
  await expect(rail).toBeVisible();
  await rail.getByRole('button', { name: 'Pull requests' }).click();
  await expect(page.getByRole('tab', { name: 'Pull requests' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Collapse the side panel' }).click();
  await rail.getByRole('button', { name: 'Open the side panel' }).click();
  await expect(page.getByRole('tab', { name: 'Pull requests' })).toHaveAttribute('aria-selected', 'true');
});

test('a Session whose run has Loopback shows a chip in its header, and one without shows none (Loopback 13)', async ({
  page,
}) => {
  await page.route('**/api/repos', (route) =>
    route.fulfill({ json: { data: [repo('r1', 'apis', 2)], meta: { next_cursor: null } } }),
  );
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({
      json: {
        data: [
          { ...session('s1', 'r1', 'engage platform', 'working'), loopback: true },
          { ...session('s2', 'r1', 'billing check', 'working'), loopback: false },
        ],
      },
    }),
  );
  await page.route('**/api/sessions/*/messages', (route) => route.fulfill({ json: { data: [] } }));
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);
  const header = page.getByRole('banner').or(page.locator('header').filter({ hasText: 'engage platform' }));
  await expect(header.getByText('Loopback on')).toBeVisible();
  await page.goto(`${daemon.url}/workspace?session=s2#token=${daemon.token}`);
  await expect(page.locator('header').filter({ hasText: 'billing check' })).toBeVisible();
  await expect(page.getByText('Loopback on')).toHaveCount(0);
});
