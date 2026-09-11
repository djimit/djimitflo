# G329 canonical loop runtime-contract proof

Date: 2026-09-11

`packages/server/src/__tests__/loops-http-proof.test.ts` mounts `/api/loops` with real JWT authentication, starts a disposable dry-run loop, reads its persisted run/review bundle, and now also executes `GET /api/loops/runtime-contracts` as the canonical runtime capability projection (`200`). The focused test remains green (1/1), and the existing step/review-bundle chain remains intact.

G329 contract inventory: 585 routes, 546 direct references, 0 critical unclassified, MCP 56/56. `/loops`: 62 files, 612 passed, 2 skipped, 0 failed. Server regression: 2,562 passed / 20 skipped. Workspace authoritative rerun: 2,853 passed / 20 skipped; the first parallel run's `/api/usage/quotas` auth race is retained separately.
