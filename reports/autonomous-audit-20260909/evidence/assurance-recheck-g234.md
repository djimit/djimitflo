# Assurance and reachability recheck — G234

`npm run assurance:truth` exits 1 as designed: supported Node, dependency audit, contract inventory, integration probes and diff checks pass; OpenMythos remains BLOCKED and live identity remains FAIL. `npm run assurance:contracts` and `npm run assurance:route-contracts` both pass at 581 routes / 341 direct references and 56/56 MCP tools. `npm run audit:tables` exits 0 and reports 165 source-discovered tables with static reachability limits. No external gate was bypassed.
