import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', '../.djimitflo-loop-worktrees/**'],
    // Bind ephemeral test servers to 127.0.0.1 (macOS cross-process port misrouting; see the helper).
    setupFiles: ['src/__tests__/helpers/loopback-listen.ts'],
    // Integration tests that exercise the loop (git worktree add + applySourceWorkingTreeDiff
    // + multiple runtime spawns + deterministic checks) legitimately exceed the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
    },
  },
});
