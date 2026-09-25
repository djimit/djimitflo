# Tasks

## Phase 1: OpenSpec Contract

- [x] Create `agentic-os-run-chain-proof` change.
- [x] Add proposal, design, tasks and requirement spec.
- [x] Add ordered `goals.batch.json`.
- [x] Add preview-only `run-goals-batch.mjs`.
- [x] Validate with `openspec validate agentic-os-run-chain-proof --strict`.

## Phase 2: Scheduler Contract Reconciliation

- [x] Inspect `swarm-resource-plan.test.ts` failures and scheduler runtime selection call path.
- [x] Define explicit runtime precedence: requested runtime wins unless blocked.
- [x] Keep adaptive runtime selection only when runtime is absent.
- [x] Update tests to assert requested runtime, effective runtime and blocked reasons.
- [x] Confirm low capacity keeps prepared leases prepared.

Validation:

- [x] `npm run test --workspace=@djimitflo/server -- swarm-resource-plan.test.ts`

## Phase 3: Plan And Prepare Chain

- [x] Add or finish operator-safe path from selected integration work item to goal, loop and prepared leases.
- [x] Store source work item id and integration metadata on goal, loop and leases.
- [x] Ensure planning/preparation starts no worker.
- [x] Add focused test for idempotent retry or clear duplicate prevention.

Validation:

- [x] Prepared maker/checker leases remain prepared until scheduler call.
- [x] Source event, work item, goal, loop and leases are queryable as one chain.

## Phase 4: Worker And Checker Smoke

- [x] Add deterministic mock integration event fixture.
- [x] Drain eligible low-risk maker through existing worker pool.
- [x] Run checker only after maker evidence exists.
- [x] Persist artifacts, gates, trace/checkpoint refs and checker verdict.
- [x] Link worker evidence to source work item and loop id.

Validation:

- [x] New `integration-spine-smoke.test.ts` proves worker/checker evidence chain.
- [x] No worker starts outside existing scheduler path.

## Phase 5: Learning Closure

- [x] Close the smoke loop through existing evolution close-loop service.
- [x] Assert eval and reflection candidate are created.
- [x] Assert reusable lesson creates memory candidate only.
- [x] Assert regression creates repair work item.
- [x] Assert missing evidence blocks closure.

Validation:

- [x] No automatic OKF memory promotion.
- [x] Closure metadata links loop, eval, reflection, memory candidate and repair work item ids.

## Phase 6: Mission Control Chain Truth

- [x] Add Integration Spine panel or finish existing Mission Control section.
- [x] Render source event through work item, goal, loop, leases, gates, eval and candidates.
- [x] Render requested runtime vs effective runtime.
- [x] Render next safe action from API state.
- [x] Handle empty/object payloads without `.map` crashes.

Validation:

- [x] `npm run test --workspace=@djimitflo/dashboard -- SwarmMissionControlPage.test.ts`
- [x] `npm run build --workspace=@djimitflo/dashboard`

## Phase 7: End-To-End Acceptance

- [x] Run deterministic mock-runtime smoke from imported integration event to learning closure.
- [x] Capture evidence ids in `evidence.md`.
- [x] Run final validation commands.

Validation commands:

- [x] `openspec validate agentic-os-run-chain-proof --strict`
- [x] `openspec validate agentic-os-integration-spine --strict`
- [x] `npm run test --workspace=@djimitflo/server -- github-cocreate.test.ts swarm-resource-plan.test.ts integration-spine-service.test.ts integration-spine-smoke.test.ts`
- [x] `npm run test --workspace=@djimitflo/dashboard -- SwarmMissionControlPage.test.ts`
- [x] `npm run type-check`
- [x] `npm run build --workspace=@djimitflo/dashboard`
- [x] `git diff --check`
