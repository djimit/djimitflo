# Design

## Shape

This is a certification layer over the existing run chain, not a new runtime system.

The runtime certification flow is:

1. Resolve candidate runtime: `codex` first, `opencode` as alternate.
2. Probe runtime contract using existing runtime contract logic.
3. Import a low-risk integration event.
4. Plan and prepare goal, loop and maker/checker leases with explicit real runtime.
5. Start workers only through the worker pool.
6. Run maker and checker as real child processes.
7. Persist runtime evidence.
8. Close learning.
9. Report production certification state in Mission Control.

## Runtime Readiness

Runtime readiness should be cheap and explicit.

Required readiness output:

- runtime name
- command path or command name
- availability
- status
- version/evidence when available
- blocked reasons
- whether smoke execution is allowed

Do not start workers from readiness checks.

## Real Runtime Smoke

The smoke must be opt-in:

```bash
RUN_REAL_RUNTIME_SMOKE=1 REAL_RUNTIME=codex npm run test --workspace=@djimitflo/server -- integration-spine-real-runtime-smoke.test.ts
```

If the env flag is absent, the test is skipped. If the flag is present and runtime readiness fails, the test fails with the blocked reason.

The smoke uses a tiny temporary git repo with harmless documentation content. It must not deploy, push, merge or edit secrets.

## Production Proof

Reuse `ProofRunService` production checks where possible. The acceptance target is a proof summary with:

- `proof_class = production`
- `production_passed = true`
- `production_missing = []`
- non-mock runtime
- real runtime usage evidence
- deterministic checks
- completed sub-agent or nested-spawn evidence when required by the current proof contract

If current proof-run production criteria are too broad for this slice, narrow only the test fixture, not the production criteria.

## Mission Control

Mission Control already shows the Integration Spine. Add production certification truth, preferably as fields on existing mission-control payload:

- latest production runtime proof
- runtime requested vs effective
- production missing reasons
- next safe action
- real-runtime smoke allowed/blocked

Avoid another dashboard route unless the existing page cannot carry the state.

## Safety Boundaries

Production here means real runtime execution, not autonomous production change.

Hard boundaries:

- low-risk work item only
- local temp repo or explicitly selected repo only
- no auto-merge
- no deploy
- no automatic memory promotion
- worker starts only through scheduler
- human/operator approval remains required for high-risk or mutating production work

## Removal Strategy

If later runtime proof is fully covered by the general proof-run service, remove the dedicated smoke wrapper and keep the readiness contract and Mission Control production fields.
