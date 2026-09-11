# G158 — `/loops` self-check after pagination hardening

Command:

```text
cd packages/server
npx vitest run src/__tests__/*loop*.test.ts --reporter=dot
```

Result: **23 test files passed; 291 tests passed; 1 explicit skip (292 total); 27.12s**.

The run revalidates planning, assignment, recovery, runtime stop, nested spawn, checker/security gates, budgets, cancellation, retry and human-approval boundaries after G156/G157. Expected negative controls remain explicit; this is local governed-loop evidence, not provider-quality, promotion or deployment proof.
