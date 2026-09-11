# G91 — `/loops` HTTP planning and review proof

The route test `packages/server/src/__tests__/loops-http-proof.test.ts` mounts the real `createLoopRoutes` with JWT authentication, a real SQLite test database and a disposable repository.

Command: `npm run test --workspace @djimitflo/server -- --run src/__tests__/loops-http-proof.test.ts`

Result: **1 test passed**.

The test proves:

- anonymous loop start is rejected with `401`;
- authenticated `POST /api/loops/start` persists a real read-only loop plan;
- `GET /api/loops/runs` returns the created run;
- `GET /api/loops/runs/:id/review-bundle` returns the durable state file, events and zero worker leases;
- `POST /api/loops/runs/:id/step` returns a persisted run decision and next actions.

This closes the route-level planning/review chain. It deliberately does not claim maker/checker execution, human approval, merge, deployment or unseen-task improvement; those remain separate governed execution evidence.
