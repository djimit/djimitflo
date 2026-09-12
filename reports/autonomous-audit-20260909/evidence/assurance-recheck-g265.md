# G265 assurance recheck

`npm run assurance:truth --silent` remains fail-closed as designed. Local gates for supported Node, dependency audit, contract inventory, integration probes and diff check pass. `openmythos_evidence` remains BLOCKED and `live_identity` remains FAIL because this audit checkout has no authenticated deployed commit identity. This is an external evidence limitation, not a social-runtime test failure.

`npm run assurance:route-contracts --silent` passes with 585 source routes, 357 direct references and 56/56 MCP tools.
