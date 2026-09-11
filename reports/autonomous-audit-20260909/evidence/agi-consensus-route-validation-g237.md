# AGI consensus route validation — G237

Focused command: `npm test -- --run src/__tests__/agi-routes.test.ts` from `packages/server`.

Result: **2 tests passed, 0 failures**. The authenticated AGI surface now has direct HTTP/SQLite proof for Observe→Deduce→Plan and for debate creation, malformed proposal/vote rejection, proposal persistence, weighted vote, resolution, retrieval and consensus statistics. Contract assurance reports 346/581 routes with direct route-test references; reasoning quality and external model execution remain unverified.
