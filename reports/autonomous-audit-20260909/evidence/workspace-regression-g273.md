# G273 workspace regression

`npm test --silent`

- 2,821 tests passed; 20 skipped; 0 failed across all workspaces
- Server package: 2,530 passed / 20 skipped
- Dashboard: 151 passed
- MCP: 41 passed
- Agent catalog: 26 passed
- Ransomware: 40 passed
- Shared: 3 passed
- Telegram: 30 passed

The first integrated run observed one transient `platform_admin /skills/reload` response of 200 instead of the fixture's expected unavailable 503. The isolated route-permission suite (13/13) and immediate complete workspace rerun passed; the observation is retained as UNKNOWN and is not treated as an authorization or availability closure.
