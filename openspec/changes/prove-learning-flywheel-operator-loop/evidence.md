# Evidence

## 2026-06-25

Validated implementation slice:

- `openspec validate prove-learning-flywheel-operator-loop --strict`
- `openspec validate knowledge-runtime-learning-flywheel --strict`
- `openspec validate real-worker-fleet-functionality-scale --strict`
- `npm run test --workspace=@djimitflo/server -- knowledge-runtime-service.test.ts knowledge-capability-sync.test.ts goal-batch-service.test.ts learning-closure-service.test.ts swarm-resource-plan.test.ts`
  - 5 test files passed
  - 40 tests passed
- `npm run test --workspace=@djimitflo/server -- learning-flywheel-smoke.test.ts`
  - 1 test passed
- `npm run test --workspace=@djimitflo/dashboard -- SwarmMissionControlPage.test.ts`
  - 2 tests passed
- `npm run type-check`
- `npm run build --workspace=@djimitflo/dashboard`
- `git diff --check`

Covered evidence:

- `GET /swarms/knowledge/runtime` resolves repo `knowledge/` and not `packages/knowledge`.
- Missing canonical OKF fails resolution.
- Knowledge health exposes validation status, counts and blocked reasons without writing OKF.
- Capability sync dry-run performs zero DB writes.
- Capability sync apply is blocked when OKF validation fails.
- Valid OKF skill syncs to validated capability; incomplete OKF skill stays candidate.
- Goal batch preview performs zero writes.
- Goal batch apply creates planning goals only and starts no workers.
- Malformed goal batch is rejected without partial import.
- Simulated low capacity blocks worker start and keeps prepared leases prepared.
- Normal scheduler capacity path remains eligible when capacity is ignored for control test.
- Learning closure route creates eval, reflection and memory candidate with promotion status `proposed`.
- End-to-end smoke validates OKF, previews/applies capability sync, previews/applies goal batch, drains mock maker/checker workers and closes learning without automatic memory promotion.
- Regression creates repair work; improvement creates skill improvement work.
- Mission Control builds with operator actions for OKF validation, sync preview/apply, goal batch preview/apply, low-capacity plan and close-loop learning.
- Dashboard fixture tests prove `knowledge/` canonical display and `packages/knowledge` drift display.
