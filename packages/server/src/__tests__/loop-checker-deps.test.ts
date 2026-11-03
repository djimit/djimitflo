import { expect, it } from 'vitest';
import fs from 'fs';

// Prod 2026-09-24: reviewer worktrees have no node_modules (by design: a checker must not run on deps the maker controls).
// Checkers either read the maker worktree (opencode external_directory deny -> exit 1) or ran npm ci and broke their
// read-only contract via a lockfile rewrite. Now: install in your own worktree; the lockfile rewrite is restored.
it('checker prompt keeps reviewers in their own worktree and the executor restores checker lockfile noise', () => {
  const loop = fs.readFileSync(new URL('../services/loop-service.ts', import.meta.url), 'utf8');
  expect(loop).toContain("Work only inside your own worktree (the maker\\'s changes are already in it); do not read the maker\\'s worktree.");
  const exec = fs.readFileSync(new URL('../services/loop-worker-executor-service.ts', import.meta.url), 'utf8');
  expect(exec).toMatch(/checkerChanged\.includes\('package-lock\.json'\) && !checkerChanged\.includes\('package\.json'\)/);
  expect(exec).toContain("'checker_lockfile_restored'");
});
