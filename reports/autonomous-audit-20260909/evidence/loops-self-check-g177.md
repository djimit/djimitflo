# G177 governed `/loops` self-check

After the G176 canvas validation and contract-inventory refresh, the complete loop-focused regression passes **23 test files, 291 tests, 1 explicit skip** (292 total). This proves local loop lifecycle and governance regressions remain green; external providers, production identity, merge and deployment remain outside this evidence.

Command: `npm run test -- --run src/__tests__/*loop*.test.ts` from `packages/server`.
