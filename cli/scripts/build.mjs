// Bundles the `ops-console` command into dist/ops-console.js for the bundled Node to run.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/ops-console.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  logLevel: 'warning',
});
