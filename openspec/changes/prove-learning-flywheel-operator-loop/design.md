# Design

## Decision

Do not add a new runtime layer.

Use the services already built:

- `KnowledgeRuntimeService` for OKF health, capability sync, specialist profiles and learning closure
- worker pool scheduler for maker/checker execution
- loop service state transitions for `ready_for_human_merge`
- existing eval, reflection, memory candidate and work item tables
- Mission Control as the operator surface

The feature is a productization and proof slice. It connects the existing pieces with explicit evidence and minimal UI actions.

## Operator Flow

The operator flow is:

1. Inspect Knowledge Runtime health.
2. Run capability sync dry-run.
3. Apply capability sync only when OKF validation passes.
4. Preview `goals.batch.json`.
5. Import selected goals without spawning workers.
6. Prepare maker/checker leases.
7. Start workers only through scheduler and resource gates.
8. Run checker and deterministic gates.
9. Move loop to `ready_for_human_merge`.
10. Close learning loop.
11. Review reflection and memory candidates.
12. Execute the next safe action: repair work, improvement work, approved memory promotion or projection reindex dry-run.

## Evidence Model

Every closed loop must link evidence through metadata:

- `loop_run_id`
- maker lease id and status
- checker lease id and verdict
- gate summary
- runner manifest or trace/checkpoint references
- eval run id
- reflection candidate id
- optional memory candidate id
- optional repair or improvement work item id
- previous score
- current score
- score delta

No evidence means no closure.

## Dashboard Changes

Mission Control should add or finish these controls:

- Knowledge Runtime action row:
  - validate OKF
  - sync capabilities dry-run
  - apply capability sync
  - close learning loop for a selected eligible loop
- Goal import preview:
  - parse `goals.batch.json`
  - show goal count, risk classes and blocked reasons
  - allow selected import into goals/work items
  - do not spawn workers from preview
- Capacity proof panel:
  - show recommended concurrency
  - show hard stop reasons
  - expose low-capacity simulation in test/API fixture only
- Learning outcome panel:
  - latest loop score delta
  - latest eval/reflection/memory candidate links
  - next safe action

## Runtime Rules

- Capability sync dry-run writes nothing.
- Capability sync apply writes only `swarm_capabilities`.
- Goal import preview writes nothing.
- Goal import apply creates planning records only; it does not start workers.
- Worker start uses the existing scheduler and resource gates.
- Learning closure refuses missing maker/checker/gate/runtime evidence.
- Memory promotion remains explicit and approval-gated.
- Qdrant and UAMS remain projections, not canonical truth.

## Minimal Implementation Strategy

Prefer small extensions over new components:

- add route handlers only where existing routes already own the action
- reuse the current API client in dashboard
- use existing table metadata columns for evidence links
- use existing mock runtime for deterministic smoke
- add one focused test per behavior that would break the product claim

No generic workflow engine is needed for this slice.
