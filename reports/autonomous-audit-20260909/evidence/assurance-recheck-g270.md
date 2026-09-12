# G270 assurance truth recheck

`npm run assurance:truth --silent` remains correctly fail-closed. Supported
Node, dependency audit, contract inventory (585 routes/358 direct, 56/56
MCP), integration probes and diff check pass. `openmythos_evidence` remains
`BLOCKED`, and `live_identity` remains `FAIL` because authenticated external
provenance is unavailable. No external gate was bypassed.
