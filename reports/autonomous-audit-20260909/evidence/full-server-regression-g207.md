# Full server regression — G207

Command: `npx vitest run --config vitest.config.mts` from `packages/server`.

Result (2026-09-10): **311 test files passed, 2 skipped; 2488 tests passed, 20 skipped, 0 failed**.

This run includes the SEGML Level-3 and production training-path repository-root regressions. Both bridges now export under the canonical monorepo `.data/segml-training` directory when launched from `packages/server`.

Scope: isolated local audit worktree; no production, provider, merge or deployment claim.
