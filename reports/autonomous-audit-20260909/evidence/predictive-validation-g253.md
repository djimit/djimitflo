# G253 — predictive intelligence admission

`POST /api/intelligence/predict` previously accepted `{}` and returned a neutral 200 prediction, which could be mistaken for an evaluated result. The route now requires non-empty `goalType`, `runtime` and `mode` strings and bounds optional `estimatedFindings` to a nonnegative integer.

Evidence: focused HTTP regression `runtime-pagination.test.ts` passes 2/2: malformed payload returns `400 VALIDATION_ERROR`; a valid zero-finding request returns 200 and preserves the neutral prior (`successProbability=0.5`, `expectedCostDollars=0.05`). Server type-check/lint, full server regression (2,513 passed / 20 skipped) and full workspace regression (2,804 passed / 20 skipped) pass. `/loops` remains 291 passed / 1 skipped.

This validates request admission only; prediction quality and external provider outcomes remain unverified.
