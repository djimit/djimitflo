# G115 memory-evolution validation

`/memory-evolution/retrieve` now rejects malformed `limit` values before candidate retrieval. The focused route test passed 3/3. A first full workspace run exposed a transient route-inventory auth-sweep mismatch (one advanced workflow route returned 200 instead of 401); the inventory test passed in isolation and the immediate complete workspace rerun passed **2724 tests / 20 skipped**. Server regression remains **2438 / 20 skipped** and `/loops` remains 12/12. The first-run mismatch is retained as UNKNOWN; no auth assertion was weakened.
