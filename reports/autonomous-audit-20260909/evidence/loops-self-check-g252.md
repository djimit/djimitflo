# G252 governed `/loops` self-check

Canonical command:

```text
npx vitest run $(rg --files src/__tests__ | rg 'loop.*\\.test\\.ts$|.*-loop\\.test\\.ts$') --no-file-parallelism --maxWorkers=1
```

Result: **23 test files passed; 291 tests passed; 1 explicit skip; 0
failures**. This revalidates loop routing, governance, recovery and runtime
stop behavior after the SEGML production-cycle repair.
