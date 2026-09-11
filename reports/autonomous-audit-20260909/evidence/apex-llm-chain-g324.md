# G324 canonical Apex LLM route proof

Date: 2026-09-11

`packages/server/src/__tests__/apex-routes.test.ts` mounts `createApexRoutes` at `/api/apex` against a fresh SQLite database and executes the LLM router chain:

- `GET /api/apex/llm/providers` returns the provider-health projection (`200`).
- `POST /api/apex/llm/performance` records a valid OpenAI coding observation (`200`).
- `GET /api/apex/llm/stats` returns the resulting router statistics projection (`200`).

The focused suite passes 3/3. G324 contract inventory reports 585 routes, 526 direct route references, 0 critical unclassified and MCP 56/56. The governed `/loops` self-check remains 62 files, 612 passed, 2 skipped, 0 failed. This is local route/database evidence; provider availability and production authentication remain unverified.
