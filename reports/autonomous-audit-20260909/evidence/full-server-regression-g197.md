# G197 — post-SBOM-root-resolution server regression

Date: 2026-09-10

Command: `RUNTIME_ROUTE_INVENTORY_PATH=reports/autonomous-audit-20260909/evidence/route-inventory-runtime-g197.json npm --workspace @djimitflo/server test -- --run`

Result: **311 test files passed, 2 skipped; 2484 tests passed, 20 skipped, 0 failed**.

The generated route inventory contains 614 registrations, 608 protected routes checked over real HTTP, and 608/608 anonymous `401` responses. Type-check, lint and server build also passed before this run.
