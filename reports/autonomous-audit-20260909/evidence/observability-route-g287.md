# G287 observability route proof

- Focused SSE test: `packages/server/src/__tests__/observability-stream.test.ts` — 1 passed.
- Existing HTTP test: `packages/server/src/__tests__/observability-pagination.test.ts` — metrics, risk trends, policy stats and execution activity plus malformed windows.
- SSE proof opens a real TCP stream, receives `text/event-stream` and a connected event, then aborts and exercises disconnect cleanup.
- Scope: local Express/SQLite/SSE observability proof; no production browser or external provider claim.

The parallel full-suite run exposed one shared-state race (`integration-spine-service`, 404 vs expected 400). The isolated server recheck passed 332 files / 2,542 tests; the workspace run passed 332 files / 2,542 server tests plus all other packages.
