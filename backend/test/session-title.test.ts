import { describe, expect, it } from 'vitest';
import { MAX_TITLE, sessionTitle } from '../src/agent/session-title';

describe('sessionTitle', () => {
  it('names a Session for the first sentence of its task, without attachments or filler', () => {
    expect(
      sessionTitle('[📎 Screenshot 2026-11-04 at 11.16.04 PM.png] can you please fix the sidebar overflow? More.'),
    ).toBe('Fix the sidebar overflow');
    expect(sessionTitle('Why does POST /fb/webhook return 500. Details follow.')).toBe(
      'Why does POST /fb/webhook return 500',
    );
  });

  it('cuts a long task at a word and ends it with an ellipsis', () => {
    const title =
      sessionTitle('Investigate why every order placed after midnight UTC fails the webhook signature check') ?? '';
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE + 1);
    expect(title).not.toMatch(/\s…$/);
  });

  it('names a message of attachments alone for them, and an empty one for nothing', () => {
    expect(sessionTitle('[📎 a.png] [📎 b.png]')).toBe('Attached files');
    expect(sessionTitle('   ')).toBeNull();
  });
});
