import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const T0 = '2026-11-06T10:00:00.000Z';
const T1 = '2026-11-06T10:05:00.000Z';
const T2 = '2026-11-06T10:10:00.000Z';

const COMMAND = 'mv /private/tmp/out/flow.pdf ~/Downloads/\n  --keep-going';

async function openSession(page: Page, outputs: object[]) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/repos', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'r1',
            name: 'apis',
            path: '/work/apis',
            host: 'github',
            remote_slug: 'example/apis',
            default_branch: 'main',
            created_at: T0,
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
  await page.route(/\/api\/sessions\?kind=repo/, (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 's1',
            kind: 'repo',
            title: 'flow',
            model: 'claude-opus-5-5',
            effort: 'medium',
            access_mode: 'auto',
            account_id: null,
            repo_id: 'r1',
            branch: 'main',
            pr_number: null,
            connection_ids: null,
            extra_repo_ids: [],
            pull_request: null,
            alert_id: null,
            state: 'idle',
            last_message_preview: null,
            last_error: null,
            created_at: T0,
            last_active_at: T0,
            playbook: null,
            queued_message: null,
          },
        ],
      },
    }),
  );
  const agent = (id: string, at: string, text: string) => ({
    id,
    role: 'agent',
    status: 'done',
    created_at: at,
    parts: [{ kind: 'text', text }],
  });
  await page.route('**/api/sessions/s1/messages', (route) =>
    route.fulfill({
      json: {
        data: [
          agent('m1', T0, `Run this:\n\n\`\`\`\n${COMMAND}\n\`\`\``),
          agent('m2', T2, 'Another turn with nothing written.'),
        ],
      },
    }),
  );
  await page.route('**/api/sessions/s1/outputs', (route) => route.fulfill({ json: { data: outputs } }));
  await page.route('**/api/sessions/s1/diff', (route) =>
    route.fulfill({ json: { data: { branch: 'main', base: 'origin/main', additions: 0, deletions: 0, files: [] } } }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);
}

test('a code block has a copy icon that copies the whole block and shows a check', async ({ page }) => {
  await openSession(page, []);
  const block = page.locator('pre', { hasText: 'mv /private/tmp/out/flow.pdf' });
  await expect(block).toBeVisible();
  const icon = page.getByRole('button', { name: 'Copy' }).first();
  // Hidden until the block is hovered or focused.
  await expect(icon).toHaveCSS('opacity', '0');
  await block.hover();
  await expect(icon).toHaveCSS('opacity', '1');
  await icon.click();
  await expect(icon).toHaveAttribute('title', 'Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(COMMAND);
  await expect(icon).toHaveAttribute('title', 'Copy');
});

test('output files show as chips on the turn that wrote them and open in the viewer', async ({ page }) => {
  await openSession(page, [
    { name: 'data.xlsx', size: 4096, modified_at: T1 },
    { name: 'flow.pdf', size: 2048, modified_at: T1 },
  ]);
  await page.route('**/api/sessions/s1/outputs/flow.pdf', (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4' }),
  );
  await page.route('**/api/sessions/s1/outputs/data.xlsx', (route) =>
    route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'bytes' }),
  );
  const chips = page.getByRole('list', { name: 'Output files' });
  // Both files were written between the first turn's start and the second's: they sit on the first turn only.
  await expect(chips).toHaveCount(1);
  await expect(chips.getByRole('button')).toHaveText(['data.xlsx', 'flow.pdf']);
  await chips.getByRole('button', { name: 'data.xlsx' }).click();
  const viewer = page.getByRole('dialog', { name: 'data.xlsx' });
  await expect(viewer).toContainText('No preview for this kind of file');
  await expect(viewer.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'data.xlsx');
});

test('a Session with no output files draws no chips', async ({ page }) => {
  await openSession(page, []);
  await expect(page.getByText('Another turn with nothing written.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Output files' })).toHaveCount(0);
});

test('a file rewritten in a later turn shows on that turn only', async ({ page }) => {
  await openSession(page, [
    { name: 'flow.pdf', size: 2048, modified_at: T1 },
    { name: 'later.csv', size: 10, modified_at: T2 },
  ]);
  const second = page.getByRole('listitem').filter({ hasText: 'Another turn with nothing written.' });
  await expect(second.getByRole('list', { name: 'Output files' }).getByRole('button')).toHaveText(['later.csv']);
  const first = page.getByRole('listitem').filter({ hasText: 'Run this:' });
  await expect(first.getByRole('list', { name: 'Output files' }).getByRole('button')).toHaveText(['flow.pdf']);
});
