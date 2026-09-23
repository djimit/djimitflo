import { expect, it } from 'vitest';
import fs from 'fs';

// Guard on the maker contract text and the executor's lockfile restore (prod 2026-09-23: npm install in the maker worktree
// rewrote package-lock.json, so a test-only change failed its "only the new test file" budget).
it('maker rules forbid installs and the executor restores a lockfile-only rewrite', () => {
  const loop = fs.readFileSync(new URL('../services/loop-service.ts', import.meta.url), 'utf8');
  expect(loop).toContain('Do not run npm install/ci or edit package.json/package-lock.json');
  const exec = fs.readFileSync(new URL('../services/loop-worker-executor-service.ts', import.meta.url), 'utf8');
  expect(exec).toMatch(/changed\.includes\('package-lock\.json'\) && !changed\.includes\('package\.json'\)/);
  expect(exec).toContain("['checkout', '--', 'package-lock.json']");
});
