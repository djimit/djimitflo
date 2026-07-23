// Stryker mutation testing configuration
// Run: npx stryker run

module.exports = {
  mutate: [
    'packages/server/src/services/tool-broker.ts',
    'packages/server/src/services/auth-service.ts',
    'packages/server/src/services/authorization-service.ts',
    'packages/server/src/services/loop-recovery-service.ts',
    'packages/server/src/services/loop-event-service.ts',
    'packages/server/src/services/loop-run-query-service.ts',
    'packages/server/src/services/loop-worker-lease-repo.ts',
    'packages/server/src/services/docker-sandbox-executor.ts',
    'packages/server/src/services/plugin-registry-service.ts',
    'packages/server/src/services/compliance-audit-service.ts',
  ],
  testRunner: 'vitest',
  reporters: ['html', 'clear-text', 'progress', 'dashboard'],
  coverageAnalysis: 'perTest',
  thresholds: {
    high: 85,
    low: 75,
    break: 70,
  },
  mutator: {
    excludedMutations: [
      'StringLiteral',
      'ObjectLiteral',
    ],
  },
  plugins: [
    '@stryker-mutator/vitest-plugin',
  ],
};
