# Route and MCP proof — G214

`route-inventory.test.ts` executed against a fresh Express/SQLite router with `RUNTIME_ROUTE_INVENTORY_PATH` enabled: **7 tests passed**. The instantiated runtime inventory contains **614 registrations**, matches all **581 source declarations** with no missing/extra/unsupported routes, and all **608 protected registrations** reject anonymous requests with HTTP 401.

`mcp-server.test.ts` now executes every registered MCP tool: **11 tests passed**. Contract inventory reports **56/56 MCP tools tested**, including authenticated council/export forwarding, local read-only tools, and explicit error responses for unavailable NotebookLM bridges. No external provider or deployment mutation was performed.

Raw outputs: [route-inventory-g214.log](route-inventory-g214.log), [contract-inventory-g214.log](contract-inventory-g214.log).
