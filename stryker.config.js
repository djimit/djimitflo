// Stryker mutation testing configuration
// Run: npx stryker run

module.exports = {
  mutate: [
    'packages/server/src/services/approval-service.ts:113:4-118:5',
    'packages/server/src/services/policy-decision-service.ts:41:6-46:7',
    'packages/server/src/execution/executors/docker-sandbox-executor.ts:282:4-289:5',
  ],
  testRunner: 'vitest',
  ignorePatterns: ['/knowledge'],
  concurrency: 4,
  reporters: ['html', 'clear-text', 'progress'],
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
    '@stryker-mutator/vitest-runner',
  ],
  vitest: { dir: 'packages', related: true },
};
