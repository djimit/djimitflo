# G245 governed `/loops` self-check

Command (from `packages/server`):

```text
npx vitest run $(rg --files src/__tests__ | rg 'loop.*\\.test\\.ts$|.*-loop\\.test\\.ts$') --no-file-parallelism --maxWorkers=1
```

Result on 2026-09-11: **23 test files passed; 291 tests passed; 1 explicit
skip; 0 failures** (143.72s). This recheck follows the Gym authentication
probe and evidence update. It remains local governance/loop evidence only.
