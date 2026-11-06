import { mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { editRoots, outsideEditRoots } from '../src/agent/edit-scope';
import { tempDir } from './helpers';

describe('file tool write scope', () => {
  it('allows the working folder, the output folder, the config folder and temp, and nothing else', async () => {
    const base = await tempDir('ops-console-scope-');
    const work = path.join(base, 'work');
    const output = path.join(base, 'out');
    const config = path.join(base, 'config');
    await mkdir(work);
    const roots = editRoots({
      workingDir: work,
      outputFolder: output,
      configDir: config,
      home: path.join(base, 'home'),
    });
    expect(outsideEditRoots(path.join(work, 'src', 'a.ts'), roots, work)).toBe(false);
    expect(outsideEditRoots('src/a.ts', roots, work)).toBe(false);
    expect(outsideEditRoots(path.join(output, 'report.md'), roots, work)).toBe(false);
    expect(outsideEditRoots(path.join(config, 'plans', 'p.md'), roots, work)).toBe(false);
    expect(outsideEditRoots('/tmp/scratch.txt', roots, work)).toBe(false);
    expect(outsideEditRoots(path.join(os.homedir(), '.zshrc'), roots, work)).toBe(true);
    // Temp is a root of its own, so the folder next to the working folder is checked against that folder alone.
    expect(outsideEditRoots('../elsewhere.txt', [work], work)).toBe(true);
    expect(outsideEditRoots(`${work}-sibling/a.ts`, [work], work)).toBe(true);
  });

  it('follows a link in the working folder out of it', async () => {
    const base = await tempDir('ops-console-scope-');
    const work = path.join(base, 'work');
    const outside = path.join(base, 'outside');
    await mkdir(work);
    await mkdir(outside);
    await symlink(outside, path.join(work, 'link'));
    expect(outsideEditRoots(path.join(work, 'link', 'x.sh'), [work], work)).toBe(true);
  });
});
