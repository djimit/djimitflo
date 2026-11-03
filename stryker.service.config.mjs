// M2 mutation-gap lane: mutation score of one service against one test file (see scripts/mutation-gain.mjs).
import os from 'node:os';
import path from 'node:path';

export default {
  mutate: [process.env.MUTATE_FILE],
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { dir: '.', related: false, configFile: 'vitest.service-mutation.config.ts' },
  ignorePatterns: ['/knowledge', '/evaluate', '/djimitflo-ruvnet-evolution', '/.playwright-cli', '/openwiki', '/reports'],
  coverageAnalysis: 'perTest',
  concurrency: 2,
  reporters: ['json'],
  jsonReporter: { fileName: process.env.MUTATE_REPORT || path.join(os.tmpdir(), 'djimitflo-mutation.json') },
  mutator: { excludedMutations: ['StringLiteral', 'ObjectLiteral'] },
};
