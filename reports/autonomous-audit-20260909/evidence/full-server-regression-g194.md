# G194 — repository-index semantic regression

Date: 2026-09-10

Command: `RUNTIME_ROUTE_INVENTORY_PATH=reports/autonomous-audit-20260909/evidence/route-inventory-runtime-g194.json npm --workspace @djimitflo/server test -- --run`

Result: **311 test files passed, 2 skipped; 2484 tests passed, 20 skipped, 0 failed**.

The same run generated `route-inventory-runtime-g194.json`: 614 registered routes, 608 protected routes checked over real HTTP, and 608/608 anonymous `401` responses. The disposable repository-index route proof is included in the critical HTTP suite.
