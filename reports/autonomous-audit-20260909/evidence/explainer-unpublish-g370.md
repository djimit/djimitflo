# G370 — Explainer bundle unpublish

Focused Vitest proof: `packages/server/src/__tests__/explainer-pagination.test.ts` (4/4 passed).

The authenticated canonical route `POST /api/explainer/bundles/bundle-unpublish/unpublish` was exercised against disposable SQLite state. A published bundle transitioned to `unpublished`, the response returned the new status, and exactly one `bundle_unpublish` audit row was persisted. The fixture uses the route's existing permission seam; no production identity or external provider claim is made.
