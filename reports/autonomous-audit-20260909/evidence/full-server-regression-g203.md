# Full server regression — G203

Command: `npx vitest run --config vitest.config.mts` from `packages/server`.

Result (2026-09-10): **311 test files passed, 2 skipped; 2487 tests passed, 20 skipped, 0 failed**.

This run includes the OpenCode health launch-context regression and confirms repository configuration discovery from `packages/server` while explicit environment configuration keeps precedence. The expected isolated fixture diagnostic (`fatal: not a git repository`) remains non-fatal and is retained as a known diagnostic.

Scope: isolated local audit worktree; no production, provider, merge or deployment claim.
