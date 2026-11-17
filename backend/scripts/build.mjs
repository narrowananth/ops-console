// Bundles the daemon into dist/main.js and the `mcp-exec` launcher into dist/mcp-exec.js, which loads only the Keychain. Native modules, the Agent SDK (it spawns the Claude Code binary from its
// platform package) and Nest's unused optional packages stay external; the release tarball installs the first two
// next to it.
import { cp, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const NATIVE = ['better-sqlite3', '@napi-rs/keyring', 'node-pty', '@anthropic-ai/claude-agent-sdk', 'playwright-core'];

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: { main: 'src/main.ts', 'mcp-exec': 'src/mcp-exec.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  keepNames: true,
  tsconfig: 'tsconfig.json',
  external: [
    ...NATIVE,
    '@nestjs/microservices',
    '@nestjs/microservices/*',
    '@nestjs/websockets',
    '@nestjs/websockets/*',
    'class-transformer',
    'class-transformer/*',
    'class-validator',
    'bufferutil',
    'utf-8-validate',
  ],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
await cp('drizzle', 'dist/drizzle', { recursive: true });
await cp('launch', 'dist/launch', { recursive: true });
// The installed daemon runs it with the previous version's app to move the Keychain items to its own.
await cp('scripts/keychain-handover.mjs', 'dist/keychain-handover.mjs');
