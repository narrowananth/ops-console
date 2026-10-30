// Builds out/ops-console-darwin-<arch>.tar.gz for the machine it runs on:
//   node scripts/package.mjs [version]
// The tarball holds this Node's own darwin build, the daemon, the UI, the CLI and the native modules built
// for that Node, so the version running here must be the version shipped.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const version = process.argv[2] ?? JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).version;
const arch = process.arch;
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) {
  throw new Error(`package on macOS arm64 or x64, not ${process.platform} ${arch}`);
}
const name = `ops-console-darwin-${arch}`;
const out = path.join(repo, 'out');
const stage = path.join(out, name);
const sh = (command, args, cwd = repo) => execFileSync(command, args, { cwd, stdio: 'inherit' });

await rm(out, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

sh('pnpm', ['-r', 'build']);

await writeFile(path.join(stage, 'VERSION'), `${version}\n`);
await cp(path.join(repo, 'install.sh'), path.join(stage, 'install.sh'));
await cp(path.join(repo, 'cli/bin'), path.join(stage, 'bin'), { recursive: true });
await cp(path.join(repo, 'cli/dist'), path.join(stage, 'cli'), { recursive: true });
await writeFile(path.join(stage, 'cli/package.json'), '{ "type": "module" }\n');
await cp(path.join(repo, 'backend/dist'), path.join(stage, 'app'), { recursive: true });
await cp(path.join(repo, 'frontend/dist'), path.join(stage, 'app/public'), { recursive: true });

// Native modules and the Agent SDK with its platform binary, at the versions the backend was tested with.
const nativeVersion = async (pkg) =>
  JSON.parse(await readFile(path.join(repo, 'backend/node_modules', pkg, 'package.json'), 'utf8')).version;
const natives = {
  'better-sqlite3': await nativeVersion('better-sqlite3'),
  '@napi-rs/keyring': await nativeVersion('@napi-rs/keyring'),
  'node-pty': await nativeVersion('node-pty'),
  '@anthropic-ai/claude-agent-sdk': await nativeVersion('@anthropic-ai/claude-agent-sdk'),
};
await writeFile(
  path.join(stage, 'app/package.json'),
  `${JSON.stringify({ name: 'ops-console-daemon', private: true, type: 'module', dependencies: natives }, null, 2)}\n`,
);
sh('npm', ['install', '--omit=dev', '--no-package-lock', '--no-audit', '--no-fund'], path.join(stage, 'app'));

// This Node's darwin build, checked against nodejs.org's published sums.
const nodeName = `node-${process.version}-darwin-${arch}`;
const nodeTarball = path.join(out, `${nodeName}.tar.gz`);
const dist = `https://nodejs.org/dist/${process.version}`;
sh('curl', ['-fsSL', `${dist}/${nodeName}.tar.gz`, '-o', nodeTarball]);
const sums = execFileSync('curl', ['-fsSL', `${dist}/SHASUMS256.txt`], { encoding: 'utf8' });
const expected = sums
  .split('\n')
  .find((line) => line.endsWith(`  ${nodeName}.tar.gz`))
  ?.split(' ')[0];
const actual = createHash('sha256')
  .update(await readFile(nodeTarball))
  .digest('hex');
if (expected !== actual) throw new Error(`checksum mismatch for ${nodeName}.tar.gz`);
await mkdir(path.join(stage, 'node'));
sh('tar', [
  '-xzf',
  nodeTarball,
  '-C',
  path.join(stage, 'node'),
  '--strip-components=1',
  `${nodeName}/bin/node`,
  `${nodeName}/LICENSE`,
]);

const tarball = path.join(out, `${name}.tar.gz`);
sh('tar', ['-czf', tarball, '-C', stage, '.']);
console.log(
  `${createHash('sha256')
    .update(await readFile(tarball))
    .digest('hex')}  ${name}.tar.gz`,
);
