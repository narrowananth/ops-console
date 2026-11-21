// Builds Chrome's DevTools frontend at the revision pinned in devtools-frontend.json, for the Inspector window:
//   node scripts/devtools-frontend.mjs [destination]
// The destination defaults to frontend/public/devtools-frontend, which Vite copies into the UI. The source is the
// ChromeDevTools/devtools-frontend repository at the pinned tag, built with its own tools (depot_tools, gn, ninja, Node)
// as Chrome builds the DevTools it embeds, and the files copied are the build's own list of what Chrome embeds. The
// build must reproduce the pinned tree hash, so a moved tag or a changed tool fails here. The checkout and its tools
// stay in .cache/devtools-frontend-build; a destination that already holds the pinned build is left alone.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const pin = JSON.parse(await readFile(path.join(import.meta.dirname, 'devtools-frontend.json'), 'utf8'));
const dest = path.resolve(process.argv[2] ?? path.join(repo, 'frontend/public/devtools-frontend'));
// Not under node_modules: the Node that runs the build refuses TypeScript files there.
const work = path.join(repo, '.cache/devtools-frontend-build');
const stamp = path.join(dest, 'PIN');
const wanted = `${pin.commit} ${pin.treeSha256}\n`;

if (existsSync(stamp) && (await readFile(stamp, 'utf8')) === wanted) {
  console.log(`DevTools frontend ${pin.tag} is in ${dest}`);
  process.exit(0);
}

const depotTools = path.join(work, 'depot_tools');
const source = path.join(work, 'devtools-frontend');
const env = { ...process.env, PATH: `${depotTools}${path.delimiter}${process.env.PATH}`, DEPOT_TOOLS_UPDATE: '0' };
const run = (command, args, cwd) => execFileSync(command, args, { cwd, env, stdio: 'inherit' });
const read = (command, args, cwd) => execFileSync(command, args, { cwd, env, encoding: 'utf8' }).trim();

/** A checkout of one commit, fetched by its hash and checked against it. */
function checkout(url, commit, dir) {
  if (existsSync(path.join(dir, '.git')) && read('git', ['rev-parse', 'HEAD'], dir) === commit) return;
  execFileSync('rm', ['-rf', dir]);
  execFileSync('mkdir', ['-p', dir]);
  run('git', ['init', '--quiet'], dir);
  run('git', ['fetch', '--quiet', '--depth', '1', url, commit], dir);
  run('git', ['checkout', '--quiet', 'FETCH_HEAD'], dir);
  if (read('git', ['rev-parse', 'HEAD'], dir) !== commit) throw new Error(`${url} did not give ${commit}`);
}

await mkdir(work, { recursive: true });
checkout(pin.depotTools.repo, pin.depotTools.commit, depotTools);
checkout(pin.repo, pin.commit, source);

await writeFile(
  path.join(work, '.gclient'),
  `solutions = [{ "name": "devtools-frontend", "url": ${JSON.stringify(pin.repo)}, "managed": False }]\n`,
);
run('gclient', ['sync', '--no-history', '--nohooks'], work);
run('gclient', ['runhooks'], work);
run(path.join(depotTools, 'ensure_bootstrap'), [], work);
run(path.join(source, 'dt'), ['build', '--build-target', 'devtools_frontend_resources'], source);

// What Chrome embeds: the build's own list of the files in its resource bundle, from the generated folder.
const generated = path.join(source, 'out/Default/gen/front_end');
const listed = JSON.parse(await readFile(path.join(source, 'out/Default/gen/expected_grd_files.json'), 'utf8'))
  .map((file) => file.replace(/^front_end\//, ''))
  .sort();
if (listed.length < 500) throw new Error(`the build lists ${listed.length} files; expected over 500`);

const staging = path.join(work, 'staging');
await rm(staging, { recursive: true, force: true });
const tree = createHash('sha256');
for (const file of listed) {
  await mkdir(path.dirname(path.join(staging, file)), { recursive: true });
  await cp(path.join(generated, file), path.join(staging, file));
  tree
    .update(`${file}\0`)
    .update(await readFile(path.join(staging, file)))
    .update('\0');
}
const treeSha256 = tree.digest('hex');
if (treeSha256 !== pin.treeSha256) {
  throw new Error(`the build gave tree hash ${treeSha256}, not the pinned ${pin.treeSha256}. Check the pin.`);
}

await rm(dest, { recursive: true, force: true });
await mkdir(path.dirname(dest), { recursive: true });
await cp(staging, dest, { recursive: true });
await writeLicences(listed);
await patchEntryPages();
await writeFile(stamp, wanted);
console.log(`DevTools frontend ${pin.tag}: ${listed.length} files in ${dest}`);

/** The page's own script runs first and adds the token to the socket; nothing may load from or call another host. */
async function patchEntryPages() {
  const shim = '<script src="/devtools-socket.js"></script>\n';
  for (const page of (await readdir(dest)).filter((name) => name.endsWith('.html'))) {
    const file = path.join(dest, page);
    let html = await readFile(file, 'utf8');
    const entry = html.match(/<script type="module" src="[^"]+"><\/script>\n/)?.[0];
    if (!entry) throw new Error(`${page} has no module script to put the socket script before`);
    html = html.replace(entry, `${shim}${entry}`);
    const policy = /script-src\s+'self' https:\/\/chrome-devtools-frontend\.appspot\.com;/;
    if (!policy.test(html) || !html.includes(' https://chromeuxreport.googleapis.com')) {
      throw new Error(`${page} has a content security policy this script does not know`);
    }
    await writeFile(
      file,
      html.replace(policy, "script-src 'self';").replace(' https://chromeuxreport.googleapis.com', ''),
    );
  }
}

/** The licence of DevTools and of each third-party package among the files, in one file beside them. */
async function writeLicences(files) {
  const packages = [...new Set(files.flatMap((file) => file.match(/^third_party\/([^/]+)\//)?.[1] ?? []))].sort();
  const parts = [
    `Chrome DevTools frontend ${pin.tag} (${pin.commit}), ${pin.repo}\nBuilt without changes by scripts/devtools-frontend.mjs.\n\n${(await readFile(path.join(source, 'LICENSE'), 'utf8')).replace(/^\/\/ ?/gm, '')}`,
  ];
  for (const name of packages) {
    const folder = path.join(source, 'front_end/third_party', name);
    const readme = await readFile(path.join(folder, 'README.chromium'), 'utf8');
    const licence = readme.match(/^License: (.+)$/m)?.[1];
    const licenceFile = readme.match(/^License File: (.+)$/m)?.[1];
    if (!licence || !licenceFile) throw new Error(`front_end/third_party/${name}/README.chromium names no licence`);
    const where = readme.match(/^URL: (.+)$/m)?.[1] ?? '';
    parts.push(`${name} (${licence}) ${where}\n\n${await readFile(path.join(folder, licenceFile), 'utf8')}`);
  }
  await writeFile(path.join(dest, 'LICENSES.txt'), `${parts.join(`\n\n${'-'.repeat(72)}\n\n`)}\n`);
}
