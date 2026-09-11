# G175 route-inventory recheck

The G174 validation/error-boundary changes altered the route source fingerprint. The instantiated inventory was regenerated against the current tree.

```text
RUNTIME_ROUTE_INVENTORY_PATH=reports/autonomous-audit-20260909/evidence/contract-inventory-runtime-g175.json npm --workspace @djimitflo/server test -- route-inventory.test.ts
Test Files 1 passed (1); Tests 7 passed (7)

CONTRACT_INVENTORY_PATH=reports/autonomous-audit-20260909/evidence/contract-inventory-g175.json RUNTIME_ROUTE_INVENTORY_PATH=reports/autonomous-audit-20260909/evidence/contract-inventory-runtime-g175.json npm run assurance:contracts
routes: total 581, tested 280, critical_unclassified 0
mcp_tools: total 56, tested 28, critical_unclassified 0
```

The runtime source fingerprint matches the current route/auth source. This remains registration and anonymous-auth evidence, not authorized domain-semantic certification.
