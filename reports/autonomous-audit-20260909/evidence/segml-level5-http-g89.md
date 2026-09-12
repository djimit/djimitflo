# G89 — SEGML Level 5 HTTP proof boundary

The authenticated route test `packages/server/src/__tests__/segml-level5-http.test.ts` exercises the mounted routes with a real in-memory SQLite database and JWT middleware.

Command: `npm run test --workspace @djimitflo/server -- --run src/__tests__/segml-level5-http.test.ts`

Result: **1 test passed**.

Observed evidence:

- unauthenticated `POST /api/segml/l5/self-improve` returns `401`;
- authenticated self-improvement returns `generation: 1`, `steps: []`, and `applied: 0`;
- authenticated status, through a newly constructed bridge instance, returns `generation: 1`, `appliedModifications: 0` and `totalEvolutionGain: 0`;
- SQLite contains zero verified modification proofs and zero evolution-log rows.
- authenticated `POST /api/segml/l5/revert/:id` returns `false` for an unknown step and returns `true` for a seeded step; the linked area is marked `reverted` and the evolution row receives `reverted_at`.

This proves the route does not turn an unproven proposal into an applied evolution result. It does not prove a real maker/checker implementation or production deployment; the governed LoopService/SelfImprovementService path remains the authority for actual self-improvement.
