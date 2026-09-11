# G251 contract and route recheck

Read-only assurance checks on the current audit checkout report:

- 581 source route declarations
- 347 direct route-test references
- 0 critical unclassified route contracts
- 56 MCP tools, all 56 with contract tests
- 614 instantiated API registrations
- 608 anonymous auth probes in the runtime artifact

`npm run assurance:contracts` and
`reconstruct-capabilities.mjs --check-route-registration` both returned
`PASS`. The additional direct reference is the public Explore leaderboard
contract test. This proves inventory, registration and auth-boundary
consistency only; it does not promote all routes to semantic end-to-end
verification.
