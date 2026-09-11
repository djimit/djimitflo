# G209 workspace regression

Command: `npm test -- --run`.

Result: **2778 tests passed, 20 skipped, 0 failed** across agent-catalog 26, dashboard 151, MCP 39, ransomware 40, server 2489, shared 3 and Telegram 30. Shared and agent-catalog builds completed before workspace tests. No deployment or merge was performed.

A preceding parallel workspace attempt exposed two negative observations: the OIDC tamper test could randomly mutate to the same signature (repaired in G210), and one viewer request in `route-permissions-http` returned 401 instead of 403. The latter passed isolated and full-server reruns and remains retained as an intermittent UNKNOWN; no auth assertion was weakened.
