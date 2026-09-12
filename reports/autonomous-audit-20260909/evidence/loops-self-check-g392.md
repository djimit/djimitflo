# Governed `/loops` self-check G392

Command: `npx vitest run $(find src/__tests__ -maxdepth 1 -type f | rg '(loop|evolution|social|self-improvement|dream|controlled-runtime)' | sort) --no-file-parallelism --maxWorkers=1 --reporter=dot` from `packages/server`.

Result: **35 test files passed, 1 skipped; 338 tests passed, 2 skipped; 0 failed.** The run includes loop lifecycle, recovery, security-checker, social-runtime and self-improvement governance tests. Expected negative-control errors are asserted by the tests; no provider promotion, merge or deployment is claimed.
