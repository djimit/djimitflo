# Prove Learning Flywheel Operator Loop

## Why

Djimitflo has most of the functional pieces for a real runtime learning system:

- canonical OKF knowledge runtime
- OKF capability sync
- real worker pool and queue model
- maker/checker leases
- deterministic gates
- close-loop eval, reflection and memory candidates
- Mission Control panels

The remaining product gap is proof and operator flow. The system can expose the parts, but an operator still needs one clear path that proves a production run learned something, measured the outcome and made the next run better without pretending that unreviewed knowledge is durable truth.

This change turns the existing implementation into a single sellable operating loop: validate knowledge, sync capabilities, run work through the fleet, close learning, show outcome deltas and create the next safe action.

## What Changes

- Add an end-to-end learning flywheel smoke that exercises the existing runtime APIs and records evidence.
- Add dashboard operator actions for knowledge validation, capability sync preview/apply and loop learning closure.
- Add batch goal import preview for `goals.batch.json` so OpenSpec goals can enter the fleet without immediate execution.
- Add a low-capacity simulation gate that proves resource-aware scaling blocks new running workers.
- Add a functional bridge from completed loops to learning closure, reflection, memory candidate and repair/improvement work items.
- Add acceptance checks that prove no automatic memory promotion, auto-merge or high-risk unattended execution occurs.

## Scope

In scope:

- existing `KnowledgeRuntimeService`
- existing worker pool, leases, loop runs and runner manifests
- existing `swarm_capabilities`, `agent_eval_runs`, `reflection_candidates`, `memory_candidates`, `work_items`, `loop_runs`, `worker_leases` and `swarm_runner_manifests`
- Mission Control dashboard controls and evidence rendering
- deterministic mock-runtime smoke plus optional live-runtime smoke

Out of scope:

- new database tables
- new agent platform
- automatic OKF memory promotion
- automatic PR merge or deploy
- unattended high-risk execution
- Qdrant or UAMS writes outside an explicit projection/reindex path

## Success Criteria

- `knowledge-runtime-learning-flywheel` Phase 7 is completed with evidence.
- `real-worker-fleet-functionality-scale` remaining functional gaps are closed:
  - batch goal import preview
  - low-capacity simulation blocks new running workers
- An operator can run the complete flow from Mission Control without reading raw stdout.
- A completed loop can produce an eval, reflection candidate, memory candidate and next work item when needed.
- A regressed loop produces repair work instead of being silently marked successful.
- Capability sync can be previewed with zero writes and applied with only `swarm_capabilities` writes.
- Candidate, draft, stale or below-threshold skills cannot route live workers.
- The dashboard labels `knowledge/` as canonical OKF and never implies `packages/knowledge` is production knowledge.
- The final smoke proves no automatic memory promotion, auto-merge, auto-deploy or high-risk unattended execution.
