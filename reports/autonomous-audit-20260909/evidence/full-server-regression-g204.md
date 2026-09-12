# Full server regression — G204

Command: `npx vitest run --config vitest.config.mts` from `packages/server`.

Result (2026-09-10): **311 test files passed, 2 skipped; 2488 tests passed, 20 skipped, 0 failed**.

This run includes the federation inbox repository-root regression and verifies the persisted loop run uses the monorepo root when no explicit federation repository is configured. The expected isolated fixture diagnostic (`fatal: not a git repository`) remains non-fatal and is retained as a known diagnostic.

Scope: isolated local audit worktree; no production, provider, merge or deployment claim.
