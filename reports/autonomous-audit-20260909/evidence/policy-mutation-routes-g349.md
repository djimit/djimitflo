# Policy mutation routes G349

`policy-mutation-audit.test.ts` now mounts the canonical `/api/policies`
router and executes:

- `PATCH /api/policies/:id` → HTTP 200, version increments, updated policy is
  returned;
- `DELETE /api/policies/:id` → HTTP 204, row is removed;
- two immutable audit events preserve the update and delete transition.

This proves the governance mutation chain locally over HTTP/SQLite.
