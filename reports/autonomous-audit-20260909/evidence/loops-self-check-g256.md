# G256 governed loop self-check

The canonical `/loops` command completed with 23 files passed, 291 tests passed, 1 skipped and 0 failed:

`npx vitest run $(rg --files src/__tests__ | rg 'loop.*\\.test\\.ts$|.*-loop\\.test\\.ts$') --no-file-parallelism --maxWorkers=1`
