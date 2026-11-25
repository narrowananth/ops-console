import { describe, expect, it } from 'vitest';
import { toComment } from '../src/workspace/bitbucket-host';
import { toReviewComment } from '../src/workspace/github-host';

const github = (extra: Record<string, unknown> = {}) => ({
  id: 11,
  user: { login: 'reviewer' },
  body: 'Name this rate.',
  created_at: '2026-11-01T09:00:00Z',
  path: 'src/tax.ts',
  line: 9,
  diff_hunk: '@@ -7,3 +7,4 @@ export function tax()\n keep\n+const rate = 1;',
  ...extra,
});

describe('a comment as the Git host gives it', () => {
  it('GitHub: the thread root carries its hunk and the thread’s outdated flag; replies carry neither', () => {
    const root = toReviewComment(github() as never, { resolved: false, outdated: true });
    expect(root).toMatchObject({
      resolved: false,
      outdated: true,
      hunk: '@@ -7,3 +7,4 @@ export function tax()\n keep\n+const rate = 1;',
    });
    const reply = toReviewComment(github({ id: 12, in_reply_to_id: 11 }) as never);
    expect(reply).toMatchObject({ parent_id: '11', outdated: null, hunk: null });
  });

  it('GitHub: a comment with no thread read says nothing about outdated', () => {
    expect(toReviewComment(github({ diff_hunk: null }) as never)).toMatchObject({ outdated: null, hunk: null });
  });

  it('Bitbucket: outdated from the inline flag, no hunk; a general comment has neither', () => {
    const inline = toComment({
      id: 5,
      content: { raw: 'Unused.' },
      inline: { path: 'src/a.ts', to: 3, outdated: true },
      created_on: '2026-11-01T09:00:00Z',
    } as never);
    expect(inline).toMatchObject({ file_path: 'src/a.ts', line: 3, outdated: true, hunk: null });
    const unflagged = toComment({
      id: 6,
      content: { raw: 'Hm.' },
      inline: { path: 'src/a.ts', to: 3 },
      created_on: '2026-11-01T09:00:00Z',
    } as never);
    expect(unflagged.outdated).toBeNull();
    const general = toComment({ id: 7, content: { raw: 'Nice.' }, created_on: '2026-11-01T09:00:00Z' } as never);
    expect(general).toMatchObject({ file_path: null, outdated: null, hunk: null });
  });
});
