# Design

## Shape

This change is a proof spine over existing services. The implementation should prefer one shared helper or service method only where current call sites already repeat the same chain assembly.

The target flow is:

1. Import or select existing integration-origin `work_items` row.
2. Plan the work item into an existing goal and loop run.
3. Prepare maker and checker leases.
4. Leave leases prepared until the scheduler is explicitly called.
5. Start maker/checker through the current worker pool.
6. Persist artifacts, gates, trace/checkpoint refs and checker verdict.
7. Close learning through the existing evolution close-loop path.
8. Expose chain state to Mission Control.

## Runtime Selection Contract

The scheduler contract must be explicit:

- If an operator, test, or smoke request supplies a runtime, that runtime is honored unless blocked by capability, risk or resource gates.
- If no runtime is supplied, existing adaptive runtime selection may choose an eligible runtime.
- Tests should assert the contract, not an accidental runtime picked by planner internals.

This keeps deterministic mock-runtime proof possible without disabling adaptive runtime selection for real runs.

## Integration Chain Metadata

Use existing metadata columns and records:

- `work_items.metadata.integration` stores source, source ref, normalized event, risk and recommended loop.
- goal metadata stores source work item id when a goal is created from integration-origin work.
- loop metadata stores source work item id, goal id and runtime request.
- lease metadata stores source work item id, loop id, role, requested runtime and effective runtime.
- closure metadata stores loop, eval, reflection, memory candidate and repair work item ids.

No new table is required for v1. If a query becomes expensive later, add a projection after the smoke is proven.

## Plan And Prepare

Add the smallest API/service path needed for operator flow. Prefer reusing existing work item, goal and scheduler services.

Required behavior:

- idempotent enough for operator retries
- creates or links one goal and one loop for the selected work item
- prepares maker/checker leases
- never starts workers
- reports blocked reasons if planning cannot proceed

## Worker And Checker Proof

Use the existing worker pool scheduler and checker bridge.

Required behavior:

- low-risk prepared maker leases can start under normal capacity
- low capacity keeps leases prepared and reports capacity reason
- checker waits for maker completion and required evidence
- high/critical risk remains gated by existing policy

## Learning Closure

Use the existing `POST /api/swarms/evolution/close-loop` behavior.

Required behavior:

- missing maker/checker/gate evidence blocks closure
- improved score creates eval and reflection
- reusable lesson creates memory candidate only
- regression creates repair work item
- no automatic durable memory promotion

## Dashboard

Mission Control needs one Integration Spine view section backed by API state, not raw stdout.

Show:

- latest imported source event
- work item, goal, loop and lease ids
- runtime requested vs effective runtime
- scheduler gate state
- maker/checker/eval state
- reflection and memory candidate ids
- next safe action

Keep Fleet Cockpit responsible for pool and capacity detail.

## Removal Strategy

If this proof path later becomes redundant, remove only the chain helper/API wrapper and keep the underlying services. The durable value is the evidence contract and tests, not a new orchestration layer.
