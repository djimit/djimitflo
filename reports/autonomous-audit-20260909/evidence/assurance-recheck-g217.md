# G217 assurance and reachability recheck

Commands rerun: `npm run assurance:truth`, `npm run assurance:contracts`, and `npm run audit:tables`.

`assurance:truth` remains **FAIL / fail-closed**: local dependency, contract, integration and diff checks pass; OpenMythos evidence is `BLOCKED` and live deployment identity is `FAIL`. Contract inventory reports **581 source routes / 299 tested** and **56/56 MCP tools** with no critical unclassified entries. Table reachability reports **167 discovered tables**, with static-analysis limitations retained.

No production mutation, merge, deployment or external authority bypass was attempted.
