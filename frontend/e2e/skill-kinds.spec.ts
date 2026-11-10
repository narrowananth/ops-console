import { readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-08T09:00:00.000Z';
const auth = { Authorization: `Bearer ${daemon.token}` };
const api = (path: string) => `${daemon.url}/api${path}`;

/** Every test starts with no pack installed, no Skill and no Playbook of the operator's. */
async function reset(request: APIRequestContext) {
  const playbooks = await request.get(api('/playbooks'), { headers: auth });
  const held = (await playbooks.json()) as { data: { items: { id: string; builtin: boolean }[] } };
  for (const playbook of held.data.items.filter((item) => !item.builtin)) {
    await request.delete(api(`/playbooks/${playbook.id}`), { headers: auth });
  }
  await request.delete(api('/skill-packs/caveman/install'), { headers: auth });
  await request.delete(api('/skill-packs/ops-console/install'), { headers: auth });
  const skills = await request.get(api('/skills'), { headers: auth });
  const list = (await skills.json()) as { data: { items: { id: string }[] } };
  for (const skill of list.data.items) await request.delete(api(`/skills/${skill.id}`), { headers: auth });
}

test.beforeEach(async ({ request }) => {
  await reset(request);
});

const openSkills = (page: Page, query = '') => page.goto(`${daemon.url}/skills${query}#token=${daemon.token}`);

test('Discover lists packs; Install makes the skills available, read in the pack and never listed in Yours', async ({
  page,
}) => {
  // Discover is the first tab and the page opens on it; New Skill belongs to Yours.
  await openSkills(page);
  await expect(page.getByRole('tab', { name: 'Discover' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '+ New Skill' })).toHaveCount(0);
  await expect(page.getByRole('tab').first()).toHaveText('Discover');
  await page.getByRole('tab', { name: 'Yours' }).click();
  await expect(page.getByText('No Skills yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: '+ New Skill' })).toBeVisible();
  // The tabs stay with no Skills; there is no empty-state card.
  await expect(page.getByRole('button', { name: 'Browse Discover' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Discover' }).click();

  const packs = page.getByRole('complementary', { name: 'Skill packs' });
  await expect(packs.getByRole('button', { name: /Caveman/ })).toContainText('9 skills');
  await expect(packs.getByRole('button', { name: /Ops Console/ })).toContainText('9 skills');
  await packs.getByRole('button', { name: /Ops Console/ }).click();
  const opsSkills = page.getByRole('list', { name: 'Ops Console skills' });
  for (const name of [
    'code-review',
    'commit-message',
    'grilling',
    'humanizer',
    'pr',
    'refactor',
    'retro',
    'ship',
    'spec',
  ]) {
    await expect(opsSkills.getByRole('button', { name: new RegExp(`^${name} `) })).toBeVisible();
  }

  await packs.getByRole('button', { name: /Caveman/ }).click();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByText('Uninstall removes all 9.')).toBeVisible();

  // The pack's skills are read in the pack, one at a time, read-only.
  const skills = page.getByRole('list', { name: 'Caveman skills' });
  await expect(skills.getByRole('listitem')).toHaveCount(9);
  await skills.getByRole('button', { name: /caveman-commit/ }).click();
  await expect(skills.getByText('Read-only')).toBeVisible();
  await expect(skills.getByRole('textbox')).toHaveCount(0);

  // Yours keeps only what the operator wrote.
  await page.getByRole('tab', { name: 'Yours' }).click();
  await expect(page.getByText('No Skills yet.')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Skills', exact: true }).getByText('caveman')).toHaveCount(0);
});

test('a link to a pack skill opens it in its pack; Uninstall asks, names the Playbooks, and removes them all', async ({
  page,
  request,
}) => {
  await request.post(api('/skill-packs/caveman/install'), { headers: auth });
  await request.post(api('/playbooks'), {
    headers: auth,
    data: { name: 'Holder', skill_ids: ['builtin:caveman/caveman-commit'] },
  });
  await openSkills(page, '?skill=builtin%3Acaveman%2Fcaveman-commit');
  const skills = page.getByRole('list', { name: 'Caveman skills' });
  await expect(skills.getByRole('button', { name: /caveman-commit/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(skills).toContainText('Held by Holder');

  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Holder');
  await expect(dialog).toContainText('All 9 skills');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Uninstall' }).click();
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
  const playbooks = (await (await request.get(api('/playbooks'), { headers: auth })).json()) as {
    data: { items: { name: string; skills: unknown[] }[] };
  };
  expect(playbooks.data.items.find((item) => item.name === 'Holder')?.skills).toEqual([]);
});

test('a Playbook picker offers pack and Custom skills with their badges', async ({ page, request }) => {
  await request.post(api('/skill-packs/caveman/install'), { headers: auth });
  await request.post(api('/skills'), {
    headers: auth,
    data: { name: 'my-method', description: 'Mine.', instructions: 'Steps.' },
  });
  const made = await request.post(api('/playbooks'), { headers: auth, data: { name: 'Picks' } });
  const id = ((await made.json()) as { data: { id: string } }).data.id;
  await page.goto(`${daemon.url}/playbooks?playbook=${id}#token=${daemon.token}`);
  const editor = page.getByRole('region', { name: 'Playbook', exact: true });
  await editor.getByRole('button', { name: 'Skills', exact: true }).click();
  const skills = editor.getByRole('complementary', { name: 'Skills panel' });
  await skills.getByRole('button', { name: '+ Add a Skill' }).click();
  await expect(skills.getByRole('button', { name: /^caveman-commit/ })).toContainText('Caveman');
  await expect(skills.getByRole('button', { name: /^my-method/ })).toContainText('Custom');
  await skills.getByRole('button', { name: /^caveman-commit/ }).click();
  await skills.getByRole('button', { name: '+ Add a Skill' }).click();
  await skills.getByRole('button', { name: /^my-method/ }).click();
  await expect(skills.getByRole('listitem')).toHaveCount(2);
});

const REPO = {
  id: 'r1',
  name: 'checkout-api',
  path: '/work/checkout-api',
  host: 'github',
  remote_slug: 'example/checkout-api',
  default_branch: 'main',
  created_at: NOW,
  branch: 'main',
  dirty: false,
  missing: false,
  session_count: 1,
};

const SESSION = {
  id: 's1',
  kind: 'repo',
  title: 'Fix the tax rule',
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
  created_at: NOW,
  last_active_at: NOW,
  playbook: null,
  queued_message: null,
};

const MENU = [
  { kind: 'builtin', name: 'caveman-commit', description: 'Conventional Commits, intent only', pack: 'caveman' },
  { kind: 'builtin', name: 'ship', description: 'Spec to committed branch and PR body', pack: 'ops-console' },
  { kind: 'project', name: 'code-review', description: 'Review the changes since a fixed point', pack: null },
  { kind: 'custom', name: 'pr-body-style', description: 'Use when writing a pull request description', pack: null },
];

async function mockSession(page: Page, sent: unknown[]) {
  await page.route('**/api/repos', (route) => route.fulfill({ json: { data: [REPO], meta: { next_cursor: null } } }));
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route(/\/api\/sessions(\?.*)?$/, (route) => route.fulfill({ json: { data: [SESSION] } }));
  await page.route(/\/api\/skill-menu\?.*/, (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    const items = MENU.filter((item) => item.name.includes(q) || item.description.toLowerCase().includes(q));
    return route.fulfill({ json: { data: { items } } });
  });
  await page.route(/\/api\/sessions\/s1\/messages$/, (route) => {
    if (route.request().method() === 'POST') {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { data: { message_id: 'm9' } } });
    }
    return route.fulfill({
      json: {
        data: [
          {
            id: 'm1',
            role: 'user',
            status: 'done',
            created_at: NOW,
            parts: [{ kind: 'text', text: '/caveman-commit only the tax fix' }],
            skill: { kind: 'builtin', name: 'caveman-commit' },
          },
          {
            id: 'm2',
            role: 'agent',
            status: 'done',
            created_at: NOW,
            parts: [{ kind: 'text', text: 'fix(tax): guard null' }],
          },
        ],
      },
    });
  });
  await page.goto(`${daemon.url}/workspace?session=s1#token=${daemon.token}`);
}

test('typing / opens the skill menu; picking keeps the note, and Send names the skill', async ({ page }) => {
  const sent: unknown[] = [];
  await mockSession(page, sent);
  const box = page.getByRole('textbox', { name: 'Message' });
  const menu = page.getByRole('listbox', { name: 'Skills' });

  await box.click();
  await page.keyboard.type('/');
  await expect(menu.getByRole('option')).toHaveCount(4);
  await expect(menu.getByRole('option').nth(0)).toContainText('/caveman-commit');
  await expect(menu.getByRole('option', { name: /code-review/ })).toContainText('Project');
  await expect(menu.getByRole('option', { name: /pr-body-style/ })).toContainText('Custom');
  await expect(menu.getByRole('option', { name: /caveman-commit/ })).toContainText('Caveman');
  // A pack's skill says which pack it is from.
  await expect(menu.getByRole('option', { name: /ship/ })).toContainText('Ops Console');

  await page.keyboard.type('code');
  await expect(menu.getByRole('option').first()).toContainText('/code-review');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect(menu.getByRole('option')).toHaveCount(4);
  await menu.getByRole('option', { name: /code-review/ }).click();
  await expect(menu).toHaveCount(0);
  await page.keyboard.type('the auth changes only');
  await expect(box).toHaveText('/code-review the auth changes only');

  await page.keyboard.press('Enter');
  await expect
    .poll(() => sent)
    .toEqual([{ text: '/code-review the auth changes only', skill: { kind: 'project', name: 'code-review' } }]);
});

test('a menu with no match says so, and a plain message sends with no skill', async ({ page }) => {
  const sent: unknown[] = [];
  await mockSession(page, sent);
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.click();
  await page.keyboard.type('/zzz');
  await expect(page.getByRole('listbox', { name: 'Skills' })).toContainText('No skills match');
  await page.keyboard.press('Escape');
  await box.evaluate((node) => {
    node.textContent = '';
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.keyboard.type('just a plain message');
  await page.keyboard.press('Enter');
  await expect.poll(() => sent).toEqual([{ text: 'just a plain message' }]);
});

test('a skill message shows its skill chip and that the Playbook was not used, after a reload', async ({ page }) => {
  await mockSession(page, []);
  const message = page.getByRole('listitem', { name: 'Your message' });
  await expect(message).toContainText('/caveman-commit');
  await expect(message).toContainText('Caveman');
  await expect(message).toContainText('Playbook not used for this message');
  await page.reload();
  await expect(page.getByRole('listitem', { name: 'Your message' })).toContainText(
    'Playbook not used for this message',
  );
});
