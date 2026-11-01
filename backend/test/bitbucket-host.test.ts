import path from 'node:path';
import { PrChecks, PrReviewState, PrState } from '@ops-console/shared';
import { describe, expect, it } from 'vitest';
import { BitbucketHost, diffFiles } from '../src/workspace/bitbucket-host';

const bkt = path.join(import.meta.dirname, 'fakes', 'bkt.mjs');

describe('Bitbucket through bkt', () => {
  it("lists every repository's pull requests in a workspace, page by page", async () => {
    const host = new BitbucketHost(bkt);
    expect(await host.owners()).toEqual(['acme']);
    const prs = await host.listOwner('acme', PrState.Open);
    expect(prs.map((pr) => [pr.slug, pr.number, pr.review_state])).toEqual(
      expect.arrayContaining([
        ['acme/orders', 1, PrReviewState.Approved],
        ['acme/billing', 2, PrReviewState.ChangesRequested],
      ]),
    );
    expect(prs.find((pr) => pr.number === 1)).toMatchObject({
      url: 'https://bitbucket.org/acme/orders/pull-requests/1',
      author: 'colleague',
      branch: 'feature-1',
      base_branch: 'main',
      head_sha: 'abc1',
      state: PrState.Open,
      checks: PrChecks.None,
      comment_count: 2,
    });
  });

  it('fails as upstream_failed when bkt does', async () => {
    const host = new BitbucketHost(bkt);
    await expect(host.list('acme/missing', PrState.Open)).rejects.toMatchObject({ code: 'upstream_failed' });
  });

  it('splits a diff per file, hunk lines only', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1..2 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
    ].join('\n');
    const files = diffFiles(diff, [{ lines_added: 1, lines_removed: 1, new: { path: 'src/app.ts' }, old: null }]);
    expect(files).toEqual([
      {
        name: 'src/app.ts',
        additions: 1,
        deletions: 1,
        lines: [
          { sign: ' ', text: '@@ -1,2 +1,2 @@' },
          { sign: ' ', text: 'keep' },
          { sign: '-', text: 'old' },
          { sign: '+', text: 'new' },
        ],
      },
    ]);
  });
});
