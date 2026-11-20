import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    // A slow runner fails one test once; a second attempt tells that from a real failure.
    retry: process.env.CI ? 1 : 0,
    // Test Repos name a GitHub origin for its host and slug; git reaches only local remotes, never the network.
    env: { GIT_ALLOW_PROTOCOL: 'file' },
  },
});
