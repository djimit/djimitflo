# G328 SEGML route-chain proof and repair

Date: 2026-09-11

`packages/server/src/__tests__/segml-routes.test.ts` mounts the canonical `/api/segml` router against SQLite and exercises:

- `GET /api/segml/generated-cases`, `judge-rubrics` and `curriculum` (`200` projections on a fresh store);
- `GET /api/segml/latest` and `blind-spots/missing` (`404` typed no-data states);
- existing bounded `GET /segml/history` validation (`400` for malformed limits, `200` empty history).

The route exposed a real runtime defect: dynamic CommonJS `require()` calls for `segml-judge-updater` and `segml-curriculum-adapter` failed under the TypeScript/ESM test runtime. `packages/server/src/routes/segml.ts` now uses the existing services via static imports; the focused suite passes 1/1.

G328 contract inventory: 585 routes, 545 direct references, 0 critical unclassified, MCP 56/56. Route registration rerun passes 10/10 and records the current source fingerprint; the first probe's single `/api/usage/quotas` anonymous `200` is retained as a transient race. `/loops` remains 62 files, 612 passed, 2 skipped, 0 failed. Server regression passes 2,562/20. Workspace authoritative rerun passes 2,562/20 after one parallel auth race (`401` vs expected `409`) in the discarded first run.
