import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/server/src/__tests__/docker-sandbox-executor.test.ts',
      'packages/server/src/__tests__/live-canvas.test.ts',
      'packages/server/src/__tests__/critical-http-contracts.test.ts',
      'packages/server/src/__tests__/manual-approvals.test.ts',
      'packages/server/src/__tests__/security-invariants.test.ts',
      'packages/server/src/__tests__/runtime-governance-release-http.test.ts',
    ],
    testTimeout: 30_000,
  },
});
