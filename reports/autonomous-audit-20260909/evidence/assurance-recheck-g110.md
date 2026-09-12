# G110 assurance recheck

`npm run assurance:truth` remains fail-closed. Local mandatory gates for Node support, dependency audit, contract inventory (581 routes, 258 tested; 56 MCP tools, 28 tested), integration probes and `git diff --check` pass. OpenMythos evidence is `BLOCKED` (insufficient executable evaluation evidence) and live deployment identity is `FAIL` (authenticated production identity/provenance unavailable), so aggregate assurance exits 1. No local product regression is inferred from these external prerequisites.
