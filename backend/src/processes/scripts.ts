import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Script, Scripts } from '@ops-console/shared';
import { z } from 'zod';

type Runner = 'pnpm' | 'npm' | 'yarn' | 'bun';

const LOCKFILES: [string, Runner][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

/** A project that lists more than this many runnable things is cut: a long Makefile would fill the menu. */
const MAX_PER_SOURCE = 60;

const packageSchema = z.object({ scripts: z.record(z.string(), z.unknown()).optional() });

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

const read = (folder: string, file: string) => readFile(path.join(folder, file), 'utf8').catch(() => null);

/** The first of `files` that is in the folder. */
async function firstOf(folder: string, files: string[]): Promise<string | null> {
  for (const file of files) if (await exists(path.join(folder, file))) return file;
  return null;
}

/** The package manager the folder's lockfile names; npm without one. */
export async function runnerOf(folder: string): Promise<Runner> {
  for (const [file, runner] of LOCKFILES) {
    if (await exists(path.join(folder, file))) return runner;
  }
  return 'npm';
}

/** A script name as one shell word: plain names stay bare, anything else is single-quoted. */
export function shellWord(name: string): string {
  return /^[\w:.@/-]+$/.test(name) ? name : `'${name.replaceAll("'", `'\\''`)}'`;
}

const entry = (source: string, name: string, run: string, command = ''): Script => ({
  id: `${source}:${name}`,
  source,
  name,
  run,
  command,
});

/** What the folder's own tool does with no setup: the commands every project of that kind has. */
const fixed = (source: string, commands: [name: string, run: string][]): Script[] =>
  commands.map(([name, run]) => entry(source, name, run, run));

async function packageScripts(folder: string): Promise<Script[]> {
  const text = await read(folder, 'package.json');
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const pkg = packageSchema.safeParse(parsed);
  if (!pkg.success) return [];
  const runner = await runnerOf(folder);
  return Object.entries(pkg.data.scripts ?? {}).flatMap(([name, command]) =>
    typeof command === 'string' ? [entry('package.json', name, `${runner} run ${shellWord(name)}`, command)] : [],
  );
}

/** Rule names of a Makefile or a justfile, with the first line of each one's recipe. */
function recipes(text: string, source: string, tool: string, rule: RegExp): Script[] {
  const lines = text.split('\n');
  const found = new Map<string, Script>();
  lines.forEach((line, index) => {
    const match = rule.exec(line);
    if (!match) return;
    const next = lines[index + 1] ?? '';
    const first = /^(?:\t| {2,})\s*(.+)$/.exec(next)?.[1]?.trim() ?? '';
    for (const name of (match[1] ?? '').split(/\s+/)) {
      if (name === '' || name.startsWith('.') || name.startsWith('_') || /[%$]/.test(name) || found.has(name)) continue;
      found.set(name, entry(source, name, `${tool} ${shellWord(name)}`, first));
    }
  });
  return [...found.values()];
}

async function makeTargets(folder: string): Promise<Script[]> {
  const file = await firstOf(folder, ['Makefile', 'makefile', 'GNUmakefile']);
  const text = file === null ? null : await read(folder, file);
  // A rule starts in column one: `name another: deps`. `:=` is an assignment and `http://` is not a rule.
  return text === null ? [] : recipes(text, 'Makefile', 'make', /^([A-Za-z0-9][\w./ -]*?)\s*:(?![=/:])/);
}

async function justRecipes(folder: string): Promise<Script[]> {
  const file = await firstOf(folder, ['justfile', 'Justfile', '.justfile']);
  const text = file === null ? null : await read(folder, file);
  return text === null ? [] : recipes(text, 'justfile', 'just', /^([A-Za-z][\w-]*)(?:\s+[^:]*)?:(?![=/:])/);
}

async function pythonCommands(folder: string): Promise<Script[]> {
  const [manage, pytestIni, pyproject, requirements] = await Promise.all([
    exists(path.join(folder, 'manage.py')),
    exists(path.join(folder, 'pytest.ini')),
    read(folder, 'pyproject.toml'),
    read(folder, 'requirements.txt'),
  ]);
  const commands: [string, string][] = [];
  if (manage) commands.push(['runserver', 'python manage.py runserver'], ['test', 'python manage.py test']);
  if (pytestIni || /pytest/.test(pyproject ?? '') || /pytest/.test(requirements ?? ''))
    commands.push(['pytest', 'pytest']);
  return fixed('Python', commands);
}

async function gradleCommands(folder: string): Promise<Script[]> {
  const wrapper = await exists(path.join(folder, 'gradlew'));
  const build = await firstOf(folder, ['build.gradle', 'build.gradle.kts']);
  if (!wrapper && build === null) return [];
  const gradle = wrapper ? './gradlew' : 'gradle';
  return fixed('Gradle', [
    ['build', `${gradle} build`],
    ['run', `${gradle} run`],
    ['test', `${gradle} test`],
  ]);
}

async function composeCommands(folder: string): Promise<Script[]> {
  const file = await firstOf(folder, ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']);
  return file === null
    ? []
    : fixed('Docker Compose', [
        ['up', 'docker compose up'],
        ['down', 'docker compose down'],
      ]);
}

/** One list per kind of project the folder is, whatever its language; a folder that is several kinds lists each. */
const DETECTORS: ((folder: string) => Promise<Script[]>)[] = [
  packageScripts,
  makeTargets,
  justRecipes,
  async (folder) =>
    (await exists(path.join(folder, 'Cargo.toml')))
      ? fixed('Cargo', [
          ['build', 'cargo build'],
          ['check', 'cargo check'],
          ['run', 'cargo run'],
          ['test', 'cargo test'],
        ])
      : [],
  async (folder) =>
    (await exists(path.join(folder, 'go.mod')))
      ? fixed('Go', [
          ['build', 'go build ./...'],
          ['run', 'go run .'],
          ['test', 'go test ./...'],
        ])
      : [],
  pythonCommands,
  gradleCommands,
  async (folder) =>
    (await exists(path.join(folder, 'pom.xml')))
      ? fixed('Maven', [
          ['install', 'mvn clean install'],
          ['package', 'mvn package'],
          ['test', 'mvn test'],
        ])
      : [],
  async (folder) =>
    (await exists(path.join(folder, 'bin', 'rails')))
      ? fixed('Rails', [
          ['server', 'bin/rails server'],
          ['test', 'bin/rails test'],
        ])
      : [],
  composeCommands,
];

/** Everything the folder can run: its package scripts, make and just recipes, and each toolchain's usual commands. */
export async function readScripts(folder: string): Promise<Scripts> {
  const lists = await Promise.all(DETECTORS.map((detect) => detect(folder).catch(() => [] as Script[])));
  return { scripts: lists.flatMap((list) => list.slice(0, MAX_PER_SOURCE)) };
}
