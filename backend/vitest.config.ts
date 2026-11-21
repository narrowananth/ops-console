import { defineConfig } from 'vitest/config';

const shared = {
  testTimeout: 60_000,
  // A slow runner fails one test once; a second attempt tells that from a real failure.
  retry: process.env.CI ? 1 : 0,
  // Test Repos name a GitHub origin for its host and slug; git reaches only local remotes, never the network.
  env: { GIT_ALLOW_PROTOCOL: 'file' },
};

// Each of these starts a real Chrome that draws and streams frames. Run side by side, or beside the whole suite, a
// runner's CPUs are short and a frame or a click arrives late, so they go one file at a time, after the rest.
const CHROME = ['test/browser*.test.ts', 'test/session-tools.test.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...shared,
          name: 'daemon',
          include: ['test/**/*.test.ts'],
          exclude: CHROME,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: { ...shared, name: 'chrome', include: CHROME, maxWorkers: 1, sequence: { groupOrder: 2 } },
      },
    ],
  },
});
