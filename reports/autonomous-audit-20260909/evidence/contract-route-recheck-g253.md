# G253 contract and registration recheck

`npm run assurance:contracts` and `npm run assurance:route-contracts` both report 581 source routes, 348 direct route-test references, 0 critical unclassified routes, and 56/56 MCP tools tested. Instantiated registration/auth graph remains 614 registrations with 608 anonymous auth probes; `reconstruct-capabilities.mjs --check-route-registration` passes. The new intelligence prediction test is now included in direct route coverage.
