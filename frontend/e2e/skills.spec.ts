import { readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { DAEMON_FILE } from './global-setup';

const daemon: { url: string; token: string } = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
const NOW = '2026-11-01T09:00:00.000Z';
const auth = { Authorization: `Bearer ${daemon.token}` };
const api = (path: string) => `${daemon.url}/api${path}`;

/** Every test starts with no Skill and no Playbook of the operator's. */
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

async function makeSkill(request: APIRequestContext, name: string, description = `Use ${name} when it applies.`) {
  const made = await request.post(api('/skills'), {
    headers: auth,
    data: { name, description, instructions: `Steps for ${name}.` },
  });
  return ((await made.json()) as { data: { id: string } }).data.id;
}

async function makePlaybook(request: APIRequestContext, name: string, skillIds: string[] = []) {
  const made = await request.post(api('/playbooks'), { headers: auth, data: { name, skill_ids: skillIds } });
  return ((await made.json()) as { data: { id: string } }).data.id;
}

const openSkills = (page: Page, id?: string) =>
  page.goto(`${daemon.url}/skills?${id ? `skill=${id}` : 'tab=yours'}#token=${daemon.token}`);

const regions = (page: Page) => ({
  list: page.getByRole('complementary', { name: 'Skills', exact: true }),
  editor: page.getByRole('region', { name: 'Skill', exact: true }),
});

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test('with no Skills Yours keeps its tabs; New Skill opens a Skill to fill in', async ({ page }) => {
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await page.getByRole('navigation').getByRole('link', { name: 'Skills' }).click();
  await page.getByRole('tab', { name: 'Yours' }).click();
  await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible();
  await expect(page.getByText('No Skills yet.')).toBeVisible();

  // The header's New Skill is the way in; the page has no empty-state card.
  await page.getByRole('button', { name: '+ New Skill' }).click();
  const { list, editor } = regions(page);
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('new-skill');
  await expect(list.getByRole('button', { name: /new-skill/ })).toContainText('0 Playbooks');

  await page.getByRole('button', { name: '+ New Skill' }).click();
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('new-skill-2');
});

test('the list is A to Z with the Playbook count; edits show a save bar, Discard restores, Save writes', async ({
  page,
  request,
}) => {
  const zeta = await makeSkill(request, 'zeta-method');
  const alpha = await makeSkill(request, 'alpha-method');
  await makePlaybook(request, 'One', [alpha]);
  await makePlaybook(request, 'Two', [alpha]);
  await openSkills(page, zeta);
  const { list, editor } = regions(page);

  await expect(list.getByRole('button')).toHaveText([/^alpha-method\s*2 Playbooks/, /^zeta-method\s*0 Playbooks/]);
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('zeta-method');
  await expect(editor).toContainText(
    'Do not put secrets, connection strings or customer data in a Skill: the agent can read its text.',
  );
  await expect(editor.getByRole('textbox', { name: 'Description' })).toHaveValue('Use zeta-method when it applies.');
  await expect(editor).toContainText(/\d+ \/ 1024/);
  await expect(editor).toContainText(/\d+ \/ 20000/);
  await expect(editor.getByRole('button', { name: 'Save' })).toHaveCount(0);

  await editor.getByRole('textbox', { name: 'Instructions' }).fill('First read the log.');
  await expect(editor.getByText('Unsaved edits')).toBeVisible();
  await expect(list.getByRole('img', { name: 'Unsaved edits' })).toBeVisible();
  await editor.getByRole('button', { name: 'Discard' }).click();
  await expect(editor.getByRole('textbox', { name: 'Instructions' })).toHaveValue('Steps for zeta-method.');
  await expect(editor.getByRole('button', { name: 'Save' })).toHaveCount(0);

  await editor.getByRole('textbox', { name: 'Name' }).fill('beta-method');
  await editor.getByRole('textbox', { name: 'Instructions' }).fill('First read the log.');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(list.getByRole('button')).toHaveText([/^alpha-method/, /^beta-method/]);

  await page.reload();
  await expect(editor.getByRole('textbox', { name: 'Instructions' })).toHaveValue('First read the log.');
});

test('a name another Skill has, or a field over its limit, refuses the save and says why', async ({
  page,
  request,
}) => {
  await makeSkill(request, 'alpha');
  const beta = await makeSkill(request, 'beta');
  await openSkills(page, beta);
  const { editor } = regions(page);

  await editor.getByRole('textbox', { name: 'Name' }).fill('alpha');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('alert')).toContainText('Another Skill is named alpha');

  await editor.getByRole('textbox', { name: 'Name' }).fill('not a valid name');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('alert')).toContainText(/name/i);

  await editor.getByRole('textbox', { name: 'Name' }).fill('beta');
  await editor.getByRole('textbox', { name: 'Description' }).fill('');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('alert')).toContainText(/description/i);
});

test('Used by links each Playbook; Delete names them, takes the Skill off and keeps the Playbooks', async ({
  page,
  request,
}) => {
  const skill = await makeSkill(request, 'trace-method');
  const keep = await makeSkill(request, 'zz-other');
  const one = await makePlaybook(request, 'Checkout deep check', [skill]);
  const two = await makePlaybook(request, 'PROD readiness', [skill, keep]);
  await openSkills(page, skill);
  const { list, editor } = regions(page);

  const used = editor.getByRole('region', { name: 'Used by' });
  await expect(used.getByRole('link', { name: 'Checkout deep check' })).toHaveAttribute(
    'href',
    `/playbooks?playbook=${one}`,
  );
  await expect(used.getByRole('link', { name: 'PROD readiness' })).toHaveAttribute(
    'href',
    `/playbooks?playbook=${two}`,
  );

  await editor.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete trace-method?' });
  await expect(dialog).toContainText('Checkout deep check and PROD readiness hold it');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(list.getByRole('button', { name: /trace-method/ })).toBeVisible();

  await editor.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(list.getByRole('button', { name: /trace-method/ })).toHaveCount(0);
  await expect(list.getByRole('button', { name: /zz-other/ })).toContainText('1 Playbook');

  await page.goto(`${daemon.url}/playbooks?playbook=${two}#token=${daemon.token}`);
  const playbook = page.getByRole('region', { name: 'Playbook', exact: true });
  await playbook.getByRole('button', { name: 'Skills', exact: true }).click();
  const held = playbook.getByRole('complementary', { name: 'Skills panel' });
  await expect(held.getByRole('listitem')).toHaveCount(1);
  await expect(held).toContainText('zz-other');
});

const skillsPanel = (page: Page) => {
  const editor = page.getByRole('region', { name: 'Playbook', exact: true });
  return {
    editor,
    card: editor.getByRole('button', { name: 'Skills', exact: true }),
    skills: editor.getByRole('complementary', { name: 'Skills panel' }),
  };
};

test('a Skill added in the Skills panel shows with a link and leaves the list of Skills to add', async ({
  page,
  request,
}) => {
  const alpha = await makeSkill(request, 'alpha-method', 'Use it to read a log.');
  await makeSkill(request, 'beta-method');
  const id = await makePlaybook(request, 'Checkout deep check');
  await page.goto(`${daemon.url}/playbooks?playbook=${id}#token=${daemon.token}`);
  const { editor, card, skills } = skillsPanel(page);
  const add = skills.getByRole('button', { name: '+ Add a Skill' });

  await card.click();
  await expect(skills).toContainText('0 / 8');
  await expect(skills).toContainText('None held. The agent follows the rules and steps only.');
  await add.click();
  await skills.getByRole('button', { name: /^alpha-method/ }).click();
  await expect(skills).toContainText('1 / 8');
  await expect(card).toContainText('alpha-method');
  const held = skills.getByRole('listitem', { name: 'alpha-method' });
  await expect(held).toContainText('Use it to read a log.');
  await expect(held.getByRole('link', { name: 'alpha-method' })).toHaveAttribute('href', `/skills?skill=${alpha}`);
  await add.click();
  await expect(skills.getByRole('button', { name: /^alpha-method/ })).toHaveCount(0);
  await expect(skills.getByRole('button', { name: /^beta-method/ })).toBeVisible();
  await expect(editor.getByText('Unsaved edits')).toBeVisible();
});

test('a Skill added to a Playbook stays after Save and reload', async ({ page, request }) => {
  await makeSkill(request, 'alpha-method', 'Use it to read a log.');
  const id = await makePlaybook(request, 'Checkout deep check');
  await page.goto(`${daemon.url}/playbooks?playbook=${id}#token=${daemon.token}`);
  const { editor, card, skills } = skillsPanel(page);

  await card.click();
  await skills.getByRole('button', { name: '+ Add a Skill' }).click();
  await skills.getByRole('button', { name: /^alpha-method/ }).click();
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await page.reload();
  await card.click();
  await expect(skills.getByRole('listitem', { name: 'alpha-method' })).toBeVisible();
});

test('Remove takes a Skill off a Playbook once saved, and the Skill itself stays', async ({ page, request }) => {
  const alpha = await makeSkill(request, 'alpha-method');
  const id = await makePlaybook(request, 'Checkout deep check', [alpha]);
  await page.goto(`${daemon.url}/playbooks?playbook=${id}#token=${daemon.token}`);
  const { editor, card, skills } = skillsPanel(page);

  await card.click();
  await skills.getByRole('button', { name: 'Remove alpha-method' }).click();
  await expect(skills).toContainText('None held.');
  await editor.getByRole('button', { name: 'Save' }).click();
  await page.reload();
  await card.click();
  await expect(skills).toContainText('0 / 8');
  await openSkills(page, alpha);
  await expect(regions(page).editor.getByRole('textbox', { name: 'Name' })).toHaveValue('alpha-method');
});

test('a Playbook holds eight Skills and refuses a ninth', async ({ page, request }) => {
  const ids: string[] = [];
  for (let n = 1; n <= 9; n += 1) ids.push(await makeSkill(request, `skill-${n}`));
  const id = await makePlaybook(request, 'Full', ids.slice(0, 8));
  await page.goto(`${daemon.url}/playbooks?playbook=${id}#token=${daemon.token}`);
  const { editor, card, skills } = skillsPanel(page);
  const add = skills.getByRole('button', { name: /Add a Skill|Hide list/ });

  await card.click();
  await expect(skills).toContainText('8 / 8');
  await expect(add).toBeDisabled();
  await skills.getByRole('button', { name: 'Remove skill-8' }).click();
  await expect(add).toBeEnabled();
  await add.click();
  await skills.getByRole('button', { name: /^skill-9/ }).click();
  await expect(skills).toContainText('8 / 8');
  await expect(add).toBeDisabled();
  await editor.getByRole('button', { name: 'Discard' }).click();
});

test('a built-in Playbook holds no Skills', async ({ page, request }) => {
  await makeSkill(request, 'alpha-method');
  await page.goto(`${daemon.url}/playbooks?trigger=verify&view=flow#token=${daemon.token}`);
  const { card, skills } = skillsPanel(page);
  await card.click();
  await expect(skills).toContainText('A built-in Playbook holds no Skills.');
  await expect(skills.getByRole('button', { name: /Add a Skill/ })).toHaveCount(0);
});

test('an Agent Review card lists the Skills it was offered; a deleted one is plain text', async ({ page }) => {
  await page.route('**/api/playbooks', (route) => route.fulfill({ json: { data: { items: [], blocks: [] } } }));
  await page.route('**/api/repos/r1/pull-requests/7', (route) =>
    route.fulfill({
      json: {
        data: {
          repo_id: 'r1',
          host: 'github',
          slug: 'example/checkout-api',
          number: 7,
          url: 'https://github.com/example/checkout-api/pull/7',
          title: 'Guard empty carts',
          author: 'someone',
          branch: 'fix/empty-cart',
          base_branch: 'main',
          head_sha: '9c1e4b7d00000000000000000000000000000000',
          state: 'open',
          review_state: 'none',
          approved_by: [],
          checks: 'passed',
          additions: 3,
          deletions: 1,
          body: '',
          opened_at: NOW,
          merged_at: null,
          is_mine: true,
          by_agent: false,
          comment_count: 0,
          resolved_count: 0,
          agent_session_id: null,
          latest_agent_review: {
            id: 'ar1',
            repo_id: 'r1',
            pr_number: 7,
            head_sha: '9c1e4b7d00000000000000000000000000000000',
            status: 'ready',
            decision: null,
            verdict: null,
            base_branch: null,
            base_sha: null,
            report: null,
            error: null,
            findings: [],
            checklist: [],
            tools: [],
            created_at: NOW,
            started_at: NOW,
            finished_at: NOW,
            stale: false,
            note: null,
            playbook: {
              id: 'pb-prod',
              name: 'PROD readiness',
              skills: [
                { id: 'sk1', name: 'systematic-debugging' },
                { id: null, name: 'old-method' },
              ],
              steps: [],
            },
          },
          files: [],
          comments: [],
          reply_checks: [],
          comment_passes: [],
        },
      },
    }),
  );
  await page.goto(`${daemon.url}/workspace?tab=pulls&pr=r1/7#token=${daemon.token}`);

  const card = page.getByRole('region', { name: 'Agent Review' });
  await expect(card).toContainText('Skills offered:');
  await expect(card.getByRole('link', { name: 'systematic-debugging' })).toHaveAttribute('href', '/skills?skill=sk1');
  await expect(card.getByText('old-method', { exact: true })).toBeVisible();
  await expect(card.getByRole('link', { name: 'old-method' })).toHaveCount(0);
});

test('a paste over 5,000 characters is refused with an error, and a shorter one goes in', async ({ page, request }) => {
  const id = await makeSkill(request, 'gamma');
  await openSkills(page, id);
  const { editor } = regions(page);
  const box = editor.getByRole('textbox', { name: 'Instructions' });
  const paste = (text: string) =>
    box.evaluate((element, value) => {
      element.focus();
      const data = new DataTransfer();
      data.setData('text/plain', value);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
  const before = await box.inputValue();

  await paste('x'.repeat(6000));
  await expect(editor.getByRole('alert')).toContainText('The limit is 5,000 characters');
  await expect(box).toHaveValue(before);

  // Typing again clears the error.
  await box.fill('Read the log first.');
  await expect(editor.getByRole('alert')).toHaveCount(0);
});
