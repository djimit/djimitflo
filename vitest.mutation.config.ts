import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/server/src/__tests__/docker-sandbox-executor.test.ts',
      'packages/server/src/__tests__/live-canvas.test.ts',
    ],
    testTimeout: 30_000,
  },
});
