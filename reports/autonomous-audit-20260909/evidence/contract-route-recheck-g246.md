# G246 contract and route recheck

Read-only assurance checks on the current audit checkout report:

- 581 source route declarations
- 346 direct route-test references
- 0 critical unclassified route contracts
- 56 MCP tools, all 56 with contract tests
- 614 instantiated API registrations
- 608 anonymous auth probes in the runtime artifact

`reconstruct-capabilities.mjs --check-route-registration` returned `PASS`.
This proves registration/auth inventory consistency only; it does not promote
all routes to semantic end-to-end verification.
