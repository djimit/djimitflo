# G173 route-inventory recheck

Executed after the workflow-node resource-boundary fixes changed the route/service source fingerprint.

```text
RUNTIME_ROUTE_INVENTORY_PATH=reports/autonomous-audit-20260909/evidence/contract-inventory-runtime-g173.json npm --workspace @djimitflo/server test -- route-inventory.test.ts
Test Files 1 passed (1)
Tests 7 passed (7)

CONTRACT_INVENTORY_PATH=reports/autonomous-audit-20260909/evidence/contract-inventory-g173.json RUNTIME_ROUTE_INVENTORY_PATH=reports/autonomous-audit-20260909/evidence/contract-inventory-runtime-g173.json npm run assurance:contracts
routes: total 581, tested 279, critical_unclassified 0
mcp_tools: total 56, tested 28, critical_unclassified 0
```

The generated runtime inventory source fingerprint matches the current route/auth source. This is registration and anonymous-auth evidence; it does not certify authorized domain semantics.
