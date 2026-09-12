# Assurance recheck — G241

Commands: `npm run assurance:truth`, `npm run assurance:contracts`, `npm run assurance:route-contracts`, `npm run assurance:integrations`, and `npm run audit:tables` from the repository root.

Local contract/integration gates remain green: **581 source routes, 346 directly tested; 56/56 MCP tools; 0 critical-unclassified**. Table reachability completes with the documented static-analysis limits (165 core source tables; 11 statically unreachable in the report). Aggregate truth remains intentionally **FAIL/BLOCKED** because OpenMythos admissibility is blocked and live deployment identity fails; no external gate was bypassed.
