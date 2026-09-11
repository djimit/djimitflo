# Real server task-chain proof — G235

Command: `npm test -- --run src/__tests__/e2e-smoke.test.ts` from `packages/server`.

Result: **1 test passed, 0 failures** in 9.96 seconds. The test boots `src/index.ts` as a real subprocess with a disposable SQLite database, logs in over HTTP, completes an authenticated WebSocket handshake, creates a task, dispatches the mock executor through the real task API and approval path, observes `completed`, and retrieves persisted execution events. This proves the local server/task spine only; it does not certify an external provider or production deployment.
