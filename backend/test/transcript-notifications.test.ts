import { describe, expect, it } from 'vitest';
import { toMessages } from '../src/agent/parts';

const entry = (type: 'user' | 'assistant', uuid: string, content: unknown) => ({
  type,
  uuid,
  parent_tool_use_id: null,
  timestamp: '2026-11-24T13:48:00.000Z',
  message: { content },
});

describe('toMessages with a task notification', () => {
  it('shows a finished background task as a step, not as an operator message', () => {
    const notification =
      '<task-notification> <task-id>b1</task-id> <status>completed</status> <summary>Background command "echo &amp;&amp; true" completed (exit code 0)</summary> </task-notification>';
    const messages = toMessages([
      entry('user', 'u1', 'run it'),
      entry('assistant', 'a1', [{ type: 'text', text: 'started' }]),
      entry('user', 'u2', notification),
      entry('assistant', 'a2', [{ type: 'text', text: 'done' }]),
    ]);
    expect(messages.map((message) => message.role)).toEqual(['user', 'agent']);
    expect(messages[1]?.parts).toEqual([
      { kind: 'text', text: 'started' },
      { kind: 'step', text: 'Background command "echo && true" completed (exit code 0)' },
      { kind: 'text', text: 'done' },
    ]);
  });
});
