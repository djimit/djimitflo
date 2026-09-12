# G151 — `/loops` self-validation checkpoint

- command: `npx vitest run src/__tests__/*loop*.test.ts --reporter=dot` from `packages/server`
- result: **23 test files passed; 291 passed, 1 skipped (292 total)**
- covered: loop service and events, routing/assignment, HTTP planning, verification/completion, runtime stop/recovery, budgets, security checker, nested spawn, cognitive/learning/research loops and self-evolving governance
- expected negative controls remained explicit (400/409 validation and governance denials, unavailable runtime and budget/security holds)
- scope: local Vitest/SQLite/disposable fixtures; no provider execution, merge, deployment or background monitor
