# Evidence: Production Pilot Runbook

## Implemented

- Mission Control now includes `production_pilot`.
- Pilot runs are selected by existing `work_items.metadata.integration.production_pilot`.
- Pilot metrics are derived from existing chain evidence: work item, goal, loop, leases, eval, reflection and memory candidate.
- Dashboard shows the latest pilot chain, metrics and next safe action.

## Pilot 1

Command:

```bash
RUN_REAL_RUNTIME_SMOKE=1 REAL_RUNTIME=codex RUNTIME_ALLOW_SKIP_PERMISSIONS=true npm run test --workspace=@djimitflo/server -- integration-spine-real-runtime-smoke.test.ts
```

Result:

```text
PASS src/__tests__/integration-spine-real-runtime-smoke.test.ts
1 passed, 1 skipped
Duration: 253.09s
```

Evidence:

- source: imported low-risk integration event
- requested runtime: `codex`
- worker start path: existing worker pool
- close-loop: asserted by test before proof-run
- production certification: asserted `status=certified`, `runtime=codex`, `production_passed=true`, `production_missing=[]`
- pilot metrics: asserted `total_runs=1`, `completed_runs=1`, `success_rate=1`, `checker_rejection_rate=0`, `manual_intervention_count=0`
- memory promotion: candidate only; no automatic durable promotion

## Remaining Operator Pilots

Pilot 2 and pilot 3 are intentionally not faked in this change. They should be run from two selected real low-risk backlog items using the same runbook.

## Validation

```bash
npm run test --workspace=@djimitflo/server -- integration-spine-smoke.test.ts integration-spine-real-runtime-smoke.test.ts
npm run test --workspace=@djimitflo/dashboard -- SwarmMissionControlPage.test.ts
npm run type-check
npm run build --workspace=@djimitflo/dashboard
openspec validate production-pilot-runbook --strict
node openspec/changes/production-pilot-runbook/run-goals-batch.mjs --dry-run
git diff --check
```

All listed validation commands passed.
