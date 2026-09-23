import { expect, it } from 'vitest';
import fs from 'fs';

// Guard on the maker contract text and the executor's lockfile restore. Prod 2026-09-23: npm install in the maker worktree
// rewrote package-lock.json (fixed by the restore); forbidding installs instead broke the makers, because loop worktrees
// have no node_modules (makers symlinked sibling deps and type-check failed, or a blocked tool call exited 1).
it('maker rules allow a clean install and the executor restores a lockfile-only rewrite', () => {
  const loop = fs.readFileSync(new URL('../services/loop-service.ts', import.meta.url), 'utf8');
  expect(loop).toContain('Install dependencies with `npm ci --legacy-peer-deps` if node_modules is missing; never edit package.json.');
  const exec = fs.readFileSync(new URL('../services/loop-worker-executor-service.ts', import.meta.url), 'utf8');
  expect(exec).toMatch(/changed\.includes\('package-lock\.json'\) && !changed\.includes\('package\.json'\)/);
  expect(exec).toContain("['checkout', '--', 'package-lock.json']");
});
