# Route inventory and anonymous boundary recheck — G234

Command: `RUNTIME_ROUTE_INVENTORY_PATH=.../route-inventory-runtime-g234.json npm test -- --run src/__tests__/route-inventory.test.ts -t 'compares instantiated'` from `packages/server`.

Result: **1 focused test passed**. Runtime evidence records 614 instantiated registrations, exact parity with 581 source declarations, 608 auth-marked registrations, and 608/608 anonymous HTTP responses with status 401. Three isolated reruns also passed. A historical full-suite intermittent observation (one 200 for `/repo-index/register` and one 404 for `/swarms/intelligence/missions`) remains retained as UNKNOWN; it was not reproduced in this recheck and is not claimed fixed by tolerance.
