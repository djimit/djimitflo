# Agent NL route validation — G232

Focused authenticated HTTP/SQLite proof for `POST /agents/create-from-description` and `POST /agents/:id/approve`:

- Blank description returns typed `400 VALIDATION_ERROR` with no draft created.
- A security-review description returns `201`, persists an inferred `security`/`high` draft with `pending_approval` status, generated system prompt and tools.
- Explicit approval returns `200` and transitions only that draft to `idle`.

Focused result: **18 tests passed, 0 failed** in `agent-lifecycle-boundary.test.ts`. This proves local governed route semantics, not external runtime activation.
