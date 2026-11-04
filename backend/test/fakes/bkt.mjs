#!/usr/bin/env node
// `bkt api <path> [-P k=v]...` answering from canned Bitbucket Cloud bodies.
import { appendFileSync } from 'node:fs';

const [, , command, path, ...rest] = process.argv;
if (command !== 'api') process.exit(2);
// BKT_LOG: every path asked for is appended here. BKT_IDLE_UPDATED: when the repository `idle` was last pushed to.
if (process.env.BKT_LOG) appendFileSync(process.env.BKT_LOG, `${path}\n`);
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
  '/user/workspaces': { values: [{ workspace: { slug: 'acme' } }] },
  '/repositories/acme':
    page === 1
      ? {
          values: [
            { slug: 'orders', updated_on: '2026-10-03T10:00:00.000000+00:00' },
            { slug: 'idle', updated_on: process.env.BKT_IDLE_UPDATED ?? '2026-09-01T10:00:00.000000+00:00' },
          ],
          next: 'https://api.example.com/next',
        }
      : { values: [{ slug: 'billing', updated_on: '2026-10-02T10:00:00.000000+00:00' }] },
  '/repositories/acme/idle/pullrequests': { values: [] },
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
