# G316 task and worker boundary evidence

Focused local HTTP/SQLite execution proves the following canonical paths:

- `GET /api/tasks/event-route-proof/events` returns a persisted task event projection for an owner-scoped task.
- `GET /tasks/:id/events` returns parsed `metadata`, `tool_input` and `tool_output` values after an execution event is persisted.
- `/api/swarms/runtime-readiness?runtime=mock` reports a non-production runtime as not startable.
- Knowledge runtime health/sync, scheduler tick, backlog sync, worker-pool plan/start/drain/stop and handoff create/drain/accept execute through the canonical `/api/swarms` mount with typed success or rejection responses.
- Missing worker leases and malformed handoffs are rejected without mutation.

Focused tests: `integration-spine-smoke.test.ts` (3/3) and `task-live-events.test.ts` (2/2).
The route inventory remains 585 total / 495 direct / 0 critical unclassified; dynamic task IDs remain classified as module-covered by the inventory tool even though the canonical static fixture was executed.
