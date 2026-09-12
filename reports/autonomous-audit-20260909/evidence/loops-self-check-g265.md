# G265 `/loops` and evolution self-check

Command: `npx vitest run $(find packages/server/src/__tests__ -maxdepth 1 -type f | rg '(loop|evolution|social|self-improvement|dream)' | sort)`

Result: 60 test files passed, 2 skipped; 603 tests passed, 2 skipped; zero failures. This includes the continuous-learning loop, interaction ledger, self-improvement, dream/evolution and signed social-runtime checks.
