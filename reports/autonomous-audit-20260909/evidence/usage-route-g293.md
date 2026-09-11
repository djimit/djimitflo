# Usage/economy route proof — G293

The focused authenticated HTTP/SQLite test `usage-routes-chain.test.ts` passed 1/1. It creates a local provider and token-usage fixture, posts a usage record, then reads the durable token, cost, quota, available-model and recent-usage projections. The assertions verify that the write is observable through the read routes rather than treating a `200` response as proof.

Evidence:

- `usage-routes-chain.test.ts`: 1 passed, exit 0 (`usage-route-g293.log`)
- server regression: 2,544 passed / 20 skipped (`server-regression-g293-rerun.md`)
- workspace regression: 2,835 passed / 20 skipped (`workspace-regression-g293.md`)
- governed `/loops`: 62 files, 612 passed / 2 skipped (`loops-self-check-g293.log`)
- route inventory: 619 registered, 610/610 anonymous auth probes rejected (`route-inventory-runtime-g293.json`)
- contract inventory: 585 declarations, 438 direct route-test references, 0 critical unclassified, 56/56 MCP tools (`contract-inventory-g293.json`)

This is local deterministic evidence only. Provider billing, authenticated production UI behavior and external certification remain unverified.
