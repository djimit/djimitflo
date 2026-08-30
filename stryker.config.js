// Stryker mutation testing configuration
// Run: npx stryker run

module.exports = {
  mutate: [
    'packages/server/src/services/approval-service.ts:116:4-118:5',
    'packages/server/src/execution/executors/docker-sandbox-executor.ts:108:2-113:3',
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
  vitest: { dir: '.', related: false, configFile: 'vitest.mutation.config.ts' },
};
