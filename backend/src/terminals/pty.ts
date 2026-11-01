import { chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export type NodePty = typeof import('node-pty');
let loaded: NodePty | undefined;

/** node-pty ships its macOS helper without the execute bit; spawning fails until it has it. */
export async function loadPty(): Promise<NodePty> {
  if (loaded) return loaded;
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    await chmod(path.join(root, 'prebuilds', arch, 'spawn-helper'), 0o755).catch(() => {});
  }
  loaded = require('node-pty') as NodePty;
  return loaded;
}
