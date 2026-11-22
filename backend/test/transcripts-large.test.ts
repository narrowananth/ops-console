import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Transcripts } from '../src/agent/transcripts';
import { removeDir, tempDir } from './helpers';

const SESSION = '3f6c1f60-0a52-4a0f-9a68-1f1d0e0b1c11';
/** A long Session's transcript, about 2 MB: 500 turns, each a prompt and a reply with a tool result. */
const TURNS = 500;
/** Far above what the read takes; it fails when a read holds the thread for a good part of a second. */
const LOOP_BOUND_MS = 400;

let configDir: string;
let file: string;

function transcriptText(): string {
  const lines: string[] = [];
  let parent: string | null = null;
  const entry = (type: 'user' | 'assistant', content: unknown) => {
    const uuid = crypto.randomUUID();
    lines.push(
      JSON.stringify({
        parentUuid: parent,
        isSidechain: false,
        type,
        message: { role: type, content },
        uuid,
        timestamp: new Date(Date.UTC(2026, 9, 30, 10, 0, lines.length)).toISOString(),
        sessionId: SESSION,
      }),
    );
    parent = uuid;
  };
  for (let turn = 0; turn < TURNS; turn++) {
    entry('user', [{ type: 'text', text: `question ${turn}` }]);
    entry('assistant', [
      { type: 'text', text: `answer ${turn} ${'x'.repeat(600)}` },
      { type: 'tool_use', id: `tool_${turn}`, name: 'Read', input: { file_path: `/src/file-${turn}.ts` } },
    ]);
    entry('user', [{ type: 'tool_result', tool_use_id: `tool_${turn}`, content: 'line of output\n'.repeat(250) }]);
  }
  return `${lines.join('\n')}\n`;
}

beforeAll(async () => {
  configDir = await tempDir('ops-console-transcript-');
  const folder = path.join(configDir, 'projects', '-work-app');
  await mkdir(folder, { recursive: true });
  file = path.join(folder, `${SESSION}.jsonl`);
  await writeFile(file, transcriptText());
});

afterAll(async () => {
  await removeDir(configDir);
});

describe('a long transcript', () => {
  it('reads without holding the thread, and a second read of the same file costs nothing', async () => {
    const transcripts = new Transcripts();
    const delay = monitorEventLoopDelay({ resolution: 5 });
    delay.enable();
    const first = await transcripts.messages(SESSION, '/work/app', configDir, undefined, null);
    delay.disable();
    const worst = delay.max / 1e6;

    expect(first.length).toBeGreaterThan(TURNS);
    expect(worst).toBeLessThan(LOOP_BOUND_MS);

    const started = performance.now();
    const again = await transcripts.messages(SESSION, '/work/app', configDir, undefined, null);
    expect(again).toBe(first);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
