# Route inventory recheck — G205

Command: `RUNTIME_ROUTE_INVENTORY_PATH=reports/autonomous-audit-20260909/evidence/route-inventory-runtime-g205.json npx vitest run src/__tests__/route-inventory.test.ts --config vitest.config.mts` from `packages/server`.

Result (2026-09-10): **7 tests passed, 0 failed**. The instantiated API contains **614 registrations**, including **608 protected routes**; all 608 anonymous probes returned **401**. The generated source fingerprint matches the current route/auth source.

Semantic authorized domain execution remains separate from this registration/auth boundary check.
