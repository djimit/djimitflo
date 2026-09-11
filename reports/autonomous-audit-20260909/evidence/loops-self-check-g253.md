# G253 loops self-check

Canonical command:

`npx vitest run $(rg --files src/__tests__ | rg 'loop.*\\.test\\.ts$|.*-loop\\.test\\.ts$') --no-file-parallelism --maxWorkers=1`

Result: 23 files passed; 291 tests passed; 1 skipped; 0 failed.
