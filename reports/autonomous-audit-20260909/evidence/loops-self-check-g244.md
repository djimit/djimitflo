# G244 governed `/loops` self-check

Command (from `packages/server`):

```text
npx vitest run $(rg --files src/__tests__ | rg 'loop.*\\.test\\.ts$|.*-loop\\.test\\.ts$') --no-file-parallelism --maxWorkers=1
```

Result on 2026-09-11: **23 test files passed; 291 tests passed; 1 explicit
skip; 0 failures** (50.36s). This is a deterministic local governance/loop
regression; it does not certify external provider quality, production identity,
or unattended merge/deployment.
