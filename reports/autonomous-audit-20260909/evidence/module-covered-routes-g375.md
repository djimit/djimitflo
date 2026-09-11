# G375 — Final route-reference closure

`packages/server/src/__tests__/module-covered-routes.test.ts` now exercises every route that was previously only module-covered, including Apex worker/plugin boundaries, Gym run/retest, SEGML run, Swarm Intelligence release/promote, public Explore projections, GitHub webhook configuration failure, Goals root, Health metrics and task events.

Focused result: 2/2 test cases passed. The route tests deliberately use bounded permission/unavailable/not-found fixtures; they prove admission and failure semantics, not provider quality or production identity.

`npm run assurance:contracts` now reports 585/585 direct route references, 0 critical unclassified and MCP 56/56.
