# G155 — `/loops` self-check after browser audit

Command:

```text
cd packages/server
npx vitest run src/__tests__/*loop*.test.ts --reporter=dot
```

Result: **23 test files passed; 291 tests passed; 1 explicit skip (292 total); 27.10s**.

The output includes the expected negative controls for unsupported loop names, exhausted worker/token/wall-clock budgets, unavailable runtimes, cancelled completion, invalid spawn tokens, checker/security gates and required human approval. This is a local governance regression, not provider-quality or production-deployment proof.
