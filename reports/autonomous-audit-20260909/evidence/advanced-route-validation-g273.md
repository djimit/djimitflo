# G273 advanced route validation

Date: 2026-09-11

The new authenticated-local HTTP fixture in `packages/server/src/__tests__/advanced-routes.test.ts` executes two complete route chains against SQLite:

1. `POST /advanced/compression/compress` → `GET /advanced/compression/retrieve/:hash` → `GET /advanced/compression/stats`. The original content, reversible flag, method, hash lookup and cache size are asserted.
2. `POST /advanced/workflows` → `GET /advanced/workflows/:id/next` → `POST /advanced/workflows/:id/nodes/:nodeId/status` → `GET /advanced/workflows/:id`. The predecessor gate, durable node output and terminal workflow status are asserted.
3. Separate gate fixtures execute `POST /advanced/workflows/:id/nodes/:nodeId/approve` and `/reject`; approval identity and failed-node state are read back from SQLite.

Focused result: **1 file, 2 tests passed, 0 failed**. This is local route/SQLite semantic evidence; it does not claim production authentication, browser execution or provider execution.
