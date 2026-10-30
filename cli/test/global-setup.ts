import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');

/** Builds the daemon and the CLI bundles the test releases pack. */
export default function setup(): void {
  for (const pkg of ['backend', 'cli']) {
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: path.join(repo, pkg), stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`${pkg} build failed`);
  }
}
