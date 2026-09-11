# G184 core execution spine recheck

The highest-centrality local chains were rerun against disposable SQLite/HTTP/runtime fixtures:

```text
npm test -- --run src/__tests__/task-live-events.test.ts src/__tests__/task-recovery.test.ts src/__tests__/task-execution-fallback-http.test.ts src/__tests__/agent-lifecycle-boundary.test.ts src/__tests__/loops-http-proof.test.ts
Test Files 5 passed (5)
Tests 31 passed (31)
```

This covers persisted task execution/fallback and runtime selection, owner-scoped WebSocket events, restart reconciliation and loop predecessor guards, agent identity/retirement boundaries, and authenticated loop planning. It is local fixture evidence; it does not certify production identity, external provider quality or deployment.
