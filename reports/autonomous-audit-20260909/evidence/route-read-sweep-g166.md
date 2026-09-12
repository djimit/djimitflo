# G166 authenticated read-route semantic sweep

Scope: four authenticated GET routes that returned server errors during the prior 308-route sweep, replayed against a fresh local `packages/server/dist` runtime on `127.0.0.1:3191` with a new SQLite database and bootstrap admin. No mutating request was issued.

| Route | Before | After | Proof |
|---|---:|---:|---|
| `/api/advanced/compression/retrieve/:hash` | 500 (`no such table: context_cache`) | 404 `NOT_FOUND` for an unknown hash | Table is now created by normal migrations; unknown content is correctly absent. |
| `/api/agi/consensus/stats` | 500 (`no such column: consensus_score`) | 200 with zeroed statistics | Migration creates and upgrades consensus columns. |
| `/api/swarms/intelligence/missions/:id` | 500 `SWARM_MISSION_NOT_FOUND` | 404 `SWARM_MISSION_NOT_FOUND` | Route maps domain not-found to HTTP 404. |
| `/api/swarms/specialist-panels/:id` | 500 `SPECIALIST_PANEL_NOT_FOUND` | 404 `SPECIALIST_PANEL_NOT_FOUND` | Route maps domain not-found to HTTP 404. |

The original broad sweep was rate-limited after 300 requests; those 429s are retained as sweep-environment evidence, not classified as product failures. The focused replay is the post-repair semantic evidence for the four genuine defects.

Validation: focused migration, compression and route regressions passed (26 tests); full server suite passed (310 files, 2470 passed, 20 skipped); server build passed.

Follow-up closure: `source-learning.test.ts` now proves a compressed original is retrievable from the same SQLite database after constructing a new service instance (simulated restart); the service persists cache entries at the shared boundary.
