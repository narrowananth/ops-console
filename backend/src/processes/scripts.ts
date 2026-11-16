import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Scripts } from '@ops-console/shared';
import { z } from 'zod';

type Runner = Scripts['runner'];

const LOCKFILES: [string, Runner][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

const packageSchema = z.object({ scripts: z.record(z.string(), z.unknown()).optional() });

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/** The package manager the folder's lockfile names; npm without one. */
export async function runnerOf(folder: string): Promise<Runner> {
  for (const [file, runner] of LOCKFILES) {
    if (await exists(path.join(folder, file))) return runner;
  }
  return 'npm';
}

/** The `scripts` of the folder's `package.json`; none when it has no file or the file does not parse. */
export async function readScripts(folder: string): Promise<Scripts> {
  const runner = await runnerOf(folder);
  const text = await readFile(path.join(folder, 'package.json'), 'utf8').catch(() => null);
  if (text === null) return { runner, scripts: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { runner, scripts: [] };
  }
  const pkg = packageSchema.safeParse(parsed);
  const entries = pkg.success ? Object.entries(pkg.data.scripts ?? {}) : [];
  return {
    runner,
    scripts: entries.flatMap(([name, command]) => (typeof command === 'string' ? [{ name, command }] : [])),
  };
}

/** A script name as one shell word: plain names stay bare, anything else is single-quoted. */
export function shellWord(name: string): string {
  return /^[\w:.@/-]+$/.test(name) ? name : `'${name.replaceAll("'", `'\\''`)}'`;
}
