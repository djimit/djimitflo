# G270 controlled evolution preparation

Command:

```sh
RUN_CONTROLLED_RUNTIME_IMPROVEMENT=1 \
CONTROLLED_RUNTIME_SCENARIO=agent-catalog \
CONTROLLED_RUNTIME_PREPARE_ONLY=1 \
npx vitest run packages/server/src/__tests__/controlled-runtime-improvement.test.ts --silent
```

Result: 2 test files passed, 2 tests passed, 0 failed in 86.32 seconds. The
disposable product-source fixture reproduced the seeded static-gate defect,
verified immutable source/dependency boundaries and baseline checks, then
cleaned up the fixture without starting a provider or changing the host
checkout. This is preparation/reproducibility evidence, not provider execution
or autonomous promotion evidence.
