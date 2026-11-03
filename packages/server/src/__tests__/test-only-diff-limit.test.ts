import { expect, it } from 'vitest';
import { testOnlyChange } from '../services/loop-worker-executor-service';

it('Y0a: a change of only test files may use 400 diff lines; anything else keeps the lane limit', () => {
  expect(testOnlyChange(['packages/server/src/__tests__/usage-service.test.ts'])).toBe(true);
  expect(testOnlyChange(['packages/dashboard/src/pages/KnowledgePage.test.tsx', 'packages/shared/src/x.spec.ts'])).toBe(true);
  expect(testOnlyChange(['packages/server/src/__tests__/a.test.ts', 'packages/server/src/services/a.ts'])).toBe(false);
  expect(testOnlyChange(['packages/server/src/services/latest.ts'])).toBe(false); // 'test' inside a name is not a test file
  expect(testOnlyChange([])).toBe(false);
});
