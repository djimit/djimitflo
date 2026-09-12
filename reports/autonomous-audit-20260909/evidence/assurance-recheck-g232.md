# Assurance recheck — G232

Commands: `npm run assurance:contracts`, `npm run assurance:route-contracts` and `npm run assurance:truth` after the NL-agent route proof.

- Contract inventory: **581 source routes, 339 direct route-test references, zero critical-unclassified; 56/56 MCP tools covered**.
- Aggregate truth: **FAIL (expected fail-closed)**. Node, dependency, contract, integration and diff gates pass; OpenMythos evidence is BLOCKED and live identity is FAIL.

No production certification or external provider claim is inferred from this local recheck.
