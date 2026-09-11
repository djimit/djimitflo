# G384 assurance recheck

Commands: `npm run assurance:truth`; `npm run assurance:live`.

Results: both exit 1 fail-closed. Local supported-node, dependency audit, contract inventory (585/585 routes; 56/56 MCP), integration probes and diff check pass. `openmythos_evidence` is BLOCKED and `live_identity` FAILS because the isolated local runtime at `127.0.0.1:3001` was not reachable; authenticated production identity and external certification remain unverified.

No credentials, external authority, promotion or deployment were used.
