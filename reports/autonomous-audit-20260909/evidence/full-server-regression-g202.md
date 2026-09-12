# Full server regression — G202

Command: `npx vitest run --config vitest.config.mts` from `packages/server`.

Result (2026-09-10): **311 test files passed, 2 skipped; 2486 tests passed, 20 skipped, 0 failed**.

This run includes the `GoalBatchService` repository-relative path regression test and confirms that a server process started from `packages/server` resolves the monorepo batch file through the shared repository-root resolver. The expected isolated fixture diagnostic (`fatal: not a git repository`) remains non-fatal and is retained as a known diagnostic.

Scope: isolated local audit worktree; no production, provider, merge or deployment claim.
