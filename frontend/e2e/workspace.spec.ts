import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
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
  extra_repo_ids: [],
  alert_id: null,
  state,
  last_message_preview: null,
  last_error: null,
  created_at: NOW,
  last_active_at: NOW,
  playbook: null,
  queued_message: null,
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

test('the tabs, search and Repo count stay in view while the Sessions list scrolls', async ({ page }) => {
  const repos = Array.from({ length: 30 }, (_, n) => repo(`r${n}`, `service-${n}`));
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: repos, meta: { next_cursor: null } } }));
  await page.route(/\/api\/sessions\?kind=repo/, (route) => route.fulfill({ json: { data: [] } }));
  await page.goto(`${daemon.url}/workspace#token=${daemon.token}`);
  const search = page.getByRole('searchbox', { name: 'Search Sessions' });
  const tabs = page.getByRole('tablist', { name: 'Workspace' });
  await expect(page.getByRole('region', { name: 'service-29' })).toHaveCount(1);

  await page.getByRole('region', { name: 'service-29' }).scrollIntoViewIfNeeded();
  await expect(tabs).toBeInViewport();
  await expect(search).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Collapse all' })).toBeInViewport();
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
  // Each file sits in the text as a chip where it was added.
  const chip = (name: string) => box.locator(`[data-file="${name}"]`);
  await expect(chip('app.log')).toContainText('2 KB');
  await expect(chip('shot.png')).toBeVisible();
  await expect(chip('order.json')).toBeVisible();
  expect(uploads).toEqual(['app.log', 'shot.png', 'order.json']);

  // Files stay with the Session through a reload.
  await page.reload();
  await expect(chip('app.log')).toContainText('2 KB');

  await chip('order.json').getByRole('button', { name: 'Remove order.json' }).click();
  await expect(chip('order.json')).toHaveCount(0);
  // The cursor after the chips, as a click past them puts it.
  await box.evaluate((element) => {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  });
  await box.pressSequentially('why does this fail?');
  await box.press('Enter');
  await expect
    .poll(() => sent?.text)
    .toBe(
      '[📎 app.log] [📎 shot.png] why does this fail?\n\nAttached files (open each with the Read tool):\n- app.log: /data/attachments/s1/1.bin\n- shot.png: /data/attachments/s1/2.bin',
    );
  await expect(box.locator('[data-file]')).toHaveCount(0);
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
  await expect(box.locator('[data-file="pasted-text.txt"]')).toBeVisible();
  // Only the card's first lines are in the box, not the 60,000 characters.
  expect(await box.evaluate((element) => element.textContent?.length ?? 0)).toBeLessThan(300);
  // The card shows the first lines, a PASTED badge and the size.
  await expect(box.locator('[data-file="pasted-text.txt"]')).toContainText('line of log line of log');
  await expect(box.locator('[data-file="pasted-text.txt"]')).toContainText('Pasted');
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
  const card = box.locator('[data-file="pasted-text.txt"]');
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
  await box.locator('[data-file="note.txt"]').click();
  await expect(page.getByRole('dialog', { name: 'note.txt' })).toContainText('hello there');
});

test('the Repos chip opens other Repos to the Session, A to Z, without its own Repo', async ({ page }) => {
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

  const chip = page.getByRole('button', { name: 'Other Repos' });
  await expect(chip).toContainText('this one');
  await chip.click();
  const picker = page.locator('[data-extra-repos]');
  const names = picker.getByRole('button', { pressed: false }).filter({ hasText: /^(admin-panel|artemis|apis)/ });
  await expect(names).toHaveText([/^admin-panel/, /^artemis/]);
  await picker.getByRole('button', { name: /^admin-panel/ }).click();
  await expect.poll(() => patches).toEqual([{ extra_repo_ids: ['r2'] }]);
  await expect(chip).toContainText('+1');
  await picker.getByRole('button', { name: /^admin-panel/ }).click();
  await expect.poll(() => patches.at(-1)).toEqual({ extra_repo_ids: [] });
  await expect(chip).toContainText('this one');
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

  await expect(page.getByRole('region', { name: 'analytics' })).toContainText('fix login');
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
