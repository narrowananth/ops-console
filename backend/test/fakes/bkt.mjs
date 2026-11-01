#!/usr/bin/env node
// `bkt api <path> [-P k=v]...` answering from canned Bitbucket Cloud bodies.
const [, , command, path, ...rest] = process.argv;
if (command !== 'api') process.exit(2);
const pr = (id, repo, extra = {}) => ({
  id,
  title: `Change ${id}`,
  description: 'Adds the thing.',
  state: 'OPEN',
  author: { display_name: 'A Colleague', nickname: 'colleague' },
  source: { branch: { name: `feature-${id}` }, commit: { hash: `abc${id}` } },
  destination: { branch: { name: 'main' } },
  created_on: `2026-10-0${id}T10:00:00.000000+00:00`,
  updated_on: `2026-10-0${id}T11:00:00.000000+00:00`,
  comment_count: 2,
  participants: [{ approved: true, state: 'approved' }],
  links: { html: { href: `https://bitbucket.org/acme/${repo}/pull-requests/${id}` } },
  ...extra,
});
const page = rest.includes('page=2') ? 2 : 1;
const bodies = {
  '/user/permissions/workspaces': { values: [{ workspace: { slug: 'acme' } }] },
  '/repositories/acme':
    page === 1
      ? { values: [{ slug: 'orders' }], next: 'https://api.example.com/next' }
      : { values: [{ slug: 'billing' }] },
  '/repositories/acme/orders/pullrequests': { values: [pr(1, 'orders')] },
  '/repositories/acme/billing/pullrequests': {
    values: [pr(2, 'billing', { participants: [{ approved: false, state: 'changes_requested' }] })],
  },
};
const body = bodies[path];
if (!body) {
  process.stderr.write(`no canned body for ${path}\n`);
  process.exit(1);
}
process.stdout.write(JSON.stringify(body));
