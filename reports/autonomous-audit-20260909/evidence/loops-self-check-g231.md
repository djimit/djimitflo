# Governed `/loops` self-check — G231

Command: `npm test -- --run src/__tests__/*loop*.test.ts` from `packages/server`.

Result: **23 test files passed; 291 tests passed; 1 explicit skip; 0 failures** (Vitest, 29.17s). This is a regression/self-check of the governed loop surface after the G230 route and evidence updates; it adds no provider or production claim.
