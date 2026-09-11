# Assurance recheck — G231

Commands: `npm run assurance:contracts`, `npm run assurance:route-contracts` and `npm run assurance:truth`.

- Contract inventory: **581 source routes, 338 direct route-test references, zero critical-unclassified; 56/56 MCP tools covered**.
- Route-contract inventory: same classified totals; anonymous protected-route probes remain covered by the existing runtime inventory evidence.
- Aggregate truth: **FAIL (expected fail-closed)**. Node, dependency, contract, integration and diff gates pass; OpenMythos evidence is BLOCKED and live identity is FAIL. No production certification is inferred.

This recheck validates gate behavior after the live-edge evidence refresh. It does not close the external prerequisites.
