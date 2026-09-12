# G323 intelligence and self-healing route proof

Date: 2026-09-11

`packages/server/src/__tests__/runtime-pagination.test.ts` mounts the canonical `/api/intelligence` router against a fresh SQLite database and executes the predictive write followed by the read/healing chain:

- `POST /api/intelligence/predict` accepts a valid bounded request and returns the persisted prediction semantics (`200`, `successProbability=0.5`, `expectedCostDollars=0.05`).
- `GET /api/intelligence/patterns`
- `GET /api/intelligence/predictive/stats`
- `GET /api/intelligence/data-quality`
- `GET /api/intelligence/health`
- `POST /api/intelligence/heal`
- `GET /api/intelligence/incidents?limit=5`
- `GET /api/intelligence/healing/stats`

All eight canonical follow-up requests returned `200` in the focused Vitest run (`2/2` tests passed). Malformed pagination and an empty predictive request remain fail-closed with `400 VALIDATION_ERROR`.

Independent gates for this checkpoint:

- `/loops`: 62 files, 612 passed, 2 skipped, 0 failed (`loops-self-check-g323.log`).
- Contract inventory: 585 routes, 523 directly tested, 0 critical unclassified; MCP 56/56 (`contract-inventory-g323.json`).
- Server regression: 336 files, 2,559 passed, 20 skipped (`server-regression-g323.log`).
- Workspace regression: 378 files, 2,850 passed, 20 skipped (`workspace-regression-g323.log`).

This is local HTTP/SQLite execution evidence only; it does not certify authenticated production identity, external provider availability or Telegram/MCP transport deployment.
