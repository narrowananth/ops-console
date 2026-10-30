// Bundles the daemon into dist/main.js. Native modules and Nest's unused optional packages stay external;
// the release tarball installs the native ones next to it.
import { cp, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const NATIVE = ['better-sqlite3', '@napi-rs/keyring'];

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
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
