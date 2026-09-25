import { expect, it } from 'vitest';
import path from 'node:path';
import { mineGymTasks, parseNumstat, selectGymTasks } from '../services/gym-task-miner';

const log = [
  '@aaa', '10\t2\tpackages/server/src/services/queue-hygiene-service.ts', '30\t0\tpackages/server/src/__tests__/queue-hygiene.test.ts',
  '@bbb', '5\t1\tpackages/server/src/services/a.ts', '5\t1\tpackages/server/src/services/b.ts', '9\t0\tpackages/server/src/__tests__/a.test.ts', // two sources
  '@ccc', '200\t50\tpackages/server/src/services/queue-hygiene-service.ts', '3\t0\tpackages/server/src/__tests__/q.test.ts', // too big
  '@ddd', '4\t1\tpackages/server/src/services/auth-service.ts', '3\t0\tpackages/server/src/__tests__/auth.test.ts', // sensitive
  '@eee', '4\t1\tpackages/server/src/services/orphan.ts', '3\t0\tpackages/server/src/__tests__/orphan.test.ts', // dead code
  '@fff', '4\t1\tpackages/server/src/services/queue-hygiene-service.ts', // no test
].join('\n');

it('selects commits that changed one small, live, non-sensitive service together with its tests', () => {
  const live = new Set(['queue-hygiene-service', 'a', 'b', 'auth-service']);
  expect(selectGymTasks(parseNumstat(log), live)).toEqual([
    { commit: 'aaa', source: 'packages/server/src/services/queue-hygiene-service.ts', tests: ['packages/server/src/__tests__/queue-hygiene.test.ts'], sourceLines: 12 },
  ]);
});

it('mines real replay tasks from this repository', () => {
  const tasks = mineGymTasks(path.resolve(__dirname, '../../../..'), { sinceDays: 3650 });
  expect(tasks.length).toBeGreaterThan(20); // prod 2026-09-25: 151 candidates since June before the live/sensitive filters
  for (const t of tasks) expect(t.source).toMatch(/^packages\/server\/src\/services\//);
});
