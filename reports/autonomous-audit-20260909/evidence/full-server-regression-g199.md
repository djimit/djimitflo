# G199 — post-documentation-root-resolution server regression

Date: 2026-09-10

Command: `RUNTIME_ROUTE_INVENTORY_PATH=reports/autonomous-audit-20260909/evidence/route-inventory-runtime-g199.json npm --workspace @djimitflo/server test -- --run`

Result: **311 test files passed, 2 skipped; 2485 tests passed, 20 skipped, 0 failed**. The route inventory remains 614 registrations with 608/608 anonymous auth denials.
