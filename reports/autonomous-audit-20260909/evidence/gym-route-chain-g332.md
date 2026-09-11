# G332 canonical Gym route proof

Date: 2026-09-11

`packages/server/src/__tests__/gym-routes.test.ts` mounts `/api/gym` and executes governance status, curriculum and history projections for a fixture skill (`200`), alongside malformed history-limit rejection (`400 VALIDATION_ERROR`).

G332 contract inventory: 585 routes, 550 direct references, 0 critical unclassified, MCP 56/56. `/loops`: 62 files, 612 passed, 2 skipped, 0 failed. Server regression: 2,562 passed / 20 skipped. Workspace regression: 2,853 passed / 20 skipped. Provider-backed evaluation remains unverified and is not inferred from these read projections.
