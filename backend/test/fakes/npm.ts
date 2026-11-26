import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NpmRunner } from '../../src/mcp/npm-packages';

type Bin = string | Record<string, string> | undefined;

/**
 * An npm that writes a package into the `--prefix` folder, as `npm install` does, and counts what it was asked.
 * `script` is the body of the package's bin, a Node script.
 */
export function fakeNpm(
  options: {
    bin?: Bin;
    delayMs?: number;
    failHalfway?: () => boolean;
    missing?: boolean;
    script?: (name: string, version: string) => string;
  } = {},
) {
  const calls: string[][] = [];
  const state = { latest: '1.0.0', installs: 0 };
  const bin = 'bin' in options ? options.bin : { server: 'server.js' };
  const npm: NpmRunner = async (args) => {
    calls.push(args);
    if (options.missing) throw Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
    if (args[0] === 'view') return `${state.latest}\n`;
    state.installs++;
    const prefix = args[args.indexOf('--prefix') + 1] ?? '';
    const spec = args[args.indexOf('--prefix') + 2] ?? '';
    const name = spec.slice(0, spec.lastIndexOf('@'));
    const asked = spec.slice(spec.lastIndexOf('@') + 1);
    const version = asked === 'latest' ? state.latest : asked;
    const pkg = path.join(prefix, 'node_modules', name);
    await mkdir(pkg, { recursive: true });
    const body = options.script?.(name, version) ?? `console.log('${name}@${version}');`;
    await writeFile(path.join(pkg, 'server.js'), `#!/usr/bin/env node\n${body}\n`);
    await chmod(path.join(pkg, 'server.js'), 0o755);
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options.failHalfway?.()) throw new Error('npm was killed');
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name, version, ...(bin ? { bin } : {}) }));
    return '';
  };
  return { npm, calls, state };
}
