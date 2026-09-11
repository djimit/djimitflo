# G243 `/loops` self-check

Command (serialized to avoid fixture contention):

```text
npx vitest run $(rg --files src/__tests__ | rg 'loop.*\.test\.ts$|.*-loop\.test\.ts$') --no-file-parallelism --maxWorkers=1
```

Result: **23 test files passed; 291 tests passed; 1 skipped; 0 failures**.

This is a local loop/runtime governance regression over disposable SQLite and
HTTP fixtures. It does not certify external provider quality, promotion, merge,
deployment or background-monitor operation.
