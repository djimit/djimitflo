# G250 workspace regression and auth intermittent

The first integrated run after adding the upstream public-leaderboard
coverage reproduced one route-inventory failure: anonymous
`GET /api/observability/policy-stats` returned 200 once. The isolated
`route-inventory.test.ts` passed immediately afterward, and a complete second
workspace run passed all packages: **2,802 passed / 20 skipped / 0 failed**
(server 2,511, dashboard 151, MCP 41, catalog 26, ransomware 40, shared 3,
Telegram 30).

The route remains guarded by mount-level and route-level `requireAuth`; the
single 200 is retained as an unresolved concurrency intermittent, not claimed
as fixed or ignored. The expected disposable non-Git diagnostic also remains
non-failing fixture output.
