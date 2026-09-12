# G321 SEGML federation and regression evidence

Canonical `/api/segml/federation` HTTP execution covers federated summary, local pattern extraction, validated peer-pattern receive and sync-history projection. Unknown peers remain rejected without writes.

- Server rerun: 336 files, 2,559 passed, 20 skipped, 0 failed.
- Workspace: 378 files, 2,850 passed, 20 skipped, 0 failed.
- `/loops`: 62 files, 612 passed, 2 skipped, 0 failed.
- Contract inventory: 585 routes, 516 direct, 0 critical unclassified; MCP 56/56.

The first server pass had one unrelated transient cognitive-route failure; the immediate rerun passed all tests and is the authoritative result. Federation remains local deterministic evidence; no external peer deployment is certified.
