# G270 route and MCP contract recheck

The runtime route inventory test passed 10/10 tests across 2 files. The
instantiated application reported 619 registered routes and 610 anonymous
authentication probes, with semantic execution kept explicitly separate.

`assurance:contracts` generated 585 source route declarations, 358 directly
exercised routes, zero unclassified critical routes, and 56/56 MCP tools with
zero critical unclassified tools. The remaining 227 routes are
`module_covered`, not silently promoted to direct execution proof.

Evidence: `route-contract-recheck-g270.log`, `route-registration-g270.log`,
`route-inventory-runtime-g270.json`, and `contract-inventory-g270.json`.

The capability reconstruction script now points at this current runtime
artifact, so a future regeneration cannot silently fall back to G266 route
evidence. The same check also passes when launched from `/tmp`, confirming
repository-root resolution is not dependent on the caller's working directory.
