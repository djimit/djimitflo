# G318 repository and full regression evidence

`repository-route-chain.test.ts` executes a real authenticated local route chain over a temporary repository: scan, durable scan projection, list, missing-detail 404, rescan, health, AGENTS.md discovery, effective instruction stack, AGENTS.md validation and repository file-change projection. Two repository scan rows are verified in SQLite.

Regression evidence:

- Server: 336 files, 2,557 passed, 20 skipped, 0 failed.
- Workspace: 378 files, 2,848 passed, 20 skipped, 0 failed.
- `/loops`: 62 files, 612 passed, 2 skipped, 0 failed.
- Contract inventory: 585 routes, 504 direct, 0 critical unclassified; MCP 56/56.

All evidence is local and does not certify production authentication, external providers or deployment identity.
