# G284 task approval/cancellation route proof

- Focused test: `packages/server/src/__tests__/task-approval-cancel-routes.test.ts`
- Result: 1 test passed.
- Chain exercised over real Express + SQLite: owned running task with pending approval; approval retrieval parses durable request/metadata JSON; cancel invokes the execution boundary and persists `cancelled`; replay returns typed `409 TASK_NOT_RUNNING`.
- Scope: route/state-machine proof with a deterministic engine fixture. No provider execution or production mutation.
