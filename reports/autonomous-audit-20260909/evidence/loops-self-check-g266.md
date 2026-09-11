# G266 `/loops` self-check

Command:

```sh
npx vitest run $(find packages/server/src/__tests__ -maxdepth 1 -type f | rg '(loop|evolution|social|self-improvement|dream)' | sort) --silent
```

Result: 60 files passed; 608 tests passed, 2 skipped, 0 failed. This includes loop routing, retry/approval governance, social runtime, evolution and self-improvement checks.
