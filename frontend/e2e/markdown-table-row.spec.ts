import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-02T09:00:00.000Z';

const session = {
  id: 's1',
  kind: 'anonymous',
  title: 'Table row',
  model: 'claude-opus-5-5',
  effort: 'medium',
  access_mode: 'full',
  account_id: null,
  repo_id: null,
  branch: null,
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

test('a table row with no rule under it draws as text, so a table still streaming in does not hang the page', async ({
  page,
}) => {
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind');
    return route.fulfill({ json: { data: kind === 'anonymous' ? [session] : [] } });
  });
  await page.route(/\/api\/sessions\/s1\/messages$/, (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'm1',
            role: 'agent',
            status: 'streaming',
            created_at: NOW,
            parts: [{ kind: 'text', text: 'Where each column goes:\n\n| Column | Goes to |' }],
          },
        ],
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);

  await expect(page.getByText('| Column | Goes to |')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Table row' })).toBeVisible();
});
