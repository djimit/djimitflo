# G326 canonical Explainer knowledge and fleet route proof

Date: 2026-09-11

`packages/server/src/__tests__/explainer-pagination.test.ts` mounts `createExplainerRoutes` at `/api/explainer` against a fresh SQLite database and exercises the knowledge boundary:

- `POST /api/explainer/knowledge/sync` returns an explicit empty sync result (`200`) on a fresh store.
- `GET /api/explainer/knowledge/search?q=governance` returns a bounded search projection (`200`).
- `GET /api/explainer/knowledge/repos` returns the repository projection (`200`).
- `GET /api/explainer/knowledge/fact/missing` returns typed `404 NOT_FOUND`.
- `GET /api/explainer/knowledge/manifest/acme/missing` returns typed `404 NOT_FOUND`.

The same canonical mount also executes fleet overview, health-drift, calibration sample/stats, audit and review-queue reads (`200`), the kill-switch mutation (`200`), and missing-bundle/review resolution guards (`404`).

The focused suite passes 2/2. G326 contract inventory reports 585 routes, 540 direct route references, 0 critical unclassified and MCP 56/56. Full server regression is 2,561 passed / 20 skipped and workspace regression 2,852 passed / 20 skipped. The governed `/loops` self-check remains 62 files, 612 passed, 2 skipped, 0 failed. This proves local route/data semantics only; Qdrant, external repository credentials and production identity remain unverified.
