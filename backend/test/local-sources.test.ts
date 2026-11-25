import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listLocalDir, readLocalFile } from '../src/anonymous-tools/local-sources';

const keep = () => 1;
const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'local-sources-')));
const home = path.join(base, 'home');
const outside = path.join(base, 'outside');
let savedHome: string | undefined;

beforeAll(() => {
  savedHome = process.env.HOME;
  mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true });
  mkdirSync(path.join(home, '.ops-console', 'secrets'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(home, 'Library', 'Keychains', 'login.keychain-db'), 'keychain');
  writeFileSync(path.join(home, '.ops-console', 'runtime.json'), 'token');
  writeFileSync(path.join(home, 'notes.txt'), 'plain notes');
  writeFileSync(path.join(outside, 'target.txt'), 'elsewhere');
  symlinkSync(path.join(home, '.ops-console'), path.join(outside, 'to-app'));
  symlinkSync(path.join(home, 'Library', 'Keychains'), path.join(home, 'keys'));
  symlinkSync(path.join(outside, 'target.txt'), path.join(home, 'link.txt'));
  process.env.HOME = home;
});

afterAll(() => {
  process.env.HOME = savedHome;
});

/** Each way to name a closed file, and the folder it sits in. */
const closedFiles = [
  ['a direct path', path.join(home, 'Library', 'Keychains', 'login.keychain-db')],
  ['the ~/ form', '~/.ops-console/runtime.json'],
  ['a link into the app folder', path.join(outside, 'to-app', 'runtime.json')],
  ['a link in the home folder', '~/keys/login.keychain-db'],
  ['a .. traversal', '~/Documents/../.ops-console/runtime.json'],
];
const closedFolders = [
  ['a direct path', path.join(home, 'Library', 'Keychains')],
  ['the ~/ form', '~/.ops-console'],
  ['a link into the app folder', path.join(outside, 'to-app')],
  ['a link in the home folder', '~/keys'],
  ['a .. traversal', '~/Library/../.ops-console/secrets'],
];

describe('the setup read tools', () => {
  it.each(closedFiles)('read_local_file refuses %s', async (_how, given) => {
    await expect(readLocalFile(given, keep)).rejects.toMatchObject({
      message: expect.stringContaining('closed to the agent'),
    });
  });

  it.each(closedFolders)('list_local_folder refuses %s', async (_how, given) => {
    await expect(listLocalDir(given)).rejects.toMatchObject({
      message: expect.stringContaining('closed to the agent'),
    });
  });

  it('a read macOS refuses tells the operator to turn on Full Disk Access', async () => {
    const shut = path.join(home, 'shut');
    mkdirSync(shut);
    writeFileSync(path.join(shut, 'inside.txt'), 'x');
    chmodSync(shut, 0o000);
    try {
      const refusal = { message: expect.stringContaining('Full Disk Access under Accounts & Usage') };
      await expect(listLocalDir(shut)).rejects.toMatchObject(refusal);
      await expect(readLocalFile(path.join(shut, 'inside.txt'), keep)).rejects.toMatchObject(refusal);
    } finally {
      chmodSync(shut, 0o700);
    }
  });

  it('still reads and lists everything else, a link to it included', async () => {
    expect((await readLocalFile('~/notes.txt', keep)).text).toBe('plain notes');
    expect((await readLocalFile('~/link.txt', keep)).text).toBe('elsewhere');
    expect((await listLocalDir('~/')).entries.map((entry) => entry.name)).toContain('notes.txt');
  });
});
