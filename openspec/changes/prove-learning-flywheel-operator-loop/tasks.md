# Tasks

## Phase 1: OpenSpec Contract

- [x] Create `prove-learning-flywheel-operator-loop` change.
- [x] Add proposal, design, tasks and requirement spec.
- [x] Add ordered `goals.batch.json` for the implementation goals.
- [x] Add dry-run helper for goal batch inspection.
- [x] Validate with `openspec validate prove-learning-flywheel-operator-loop --strict`.

## Phase 2: Knowledge Runtime Smoke

- [x] Add a deterministic smoke script or test that calls `GET /api/swarms/knowledge/runtime`.
- [x] Assert canonical OKF resolves to repo `knowledge/`.
- [x] Assert `packages/knowledge` is not reported as production canonical knowledge.
- [x] Assert OKF validation result, folder counts and blocked reasons are visible.
- [x] Assert health checks do not write OKF files.

Validation:

- [x] Smoke fails when canonical OKF is missing.
- [x] Smoke fails when runtime would silently fall back to `packages/knowledge`.

## Phase 3: Capability Sync Proof

- [x] Extend or add a smoke that runs capability sync with `dry_run: true`.
- [x] Assert dry-run returns create/update/block counts without DB mutation.
- [x] Run capability sync with `apply: true` only after OKF validation passes.
- [x] Assert apply upserts `swarm_capabilities` only.
- [x] Assert candidate/draft/incomplete capabilities cannot route live workers.
- [x] Assert source path, content hash, missing fields and validation evidence are stored in metadata.

Validation:

- [x] Valid OKF skill can become a gated capability.
- [x] Incomplete OKF skill remains candidate.
- [x] Failed OKF validation blocks apply sync.

## Phase 4: Goal Import Preview

- [x] Add batch goal import preview for `goals.batch.json`.
- [x] Preview goal count, risk class, target repo/path and blocked reasons.
- [x] Allow selected import into existing planning records without starting workers.
- [x] Show import preview in Mission Control or existing fleet cockpit.
- [x] Add tests that preview performs zero writes.

Validation:

- [x] Malformed batch reports line/item errors without partial import.
- [x] Preview does not create goals, work items, loops or leases.
- [x] Apply creates planning records but no running workers.

## Phase 5: Resource-Aware Scaling Proof

- [x] Add low-capacity simulation for the worker scheduler/resource gate.
- [x] Assert low memory or high load blocks new running worker starts.
- [x] Assert prepared leases remain prepared under low capacity.
- [x] Assert API response explains the blocked reason.
- [x] Show blocked capacity reason in dashboard.

Validation:

- [x] Low capacity simulation blocks new running workers.
- [x] Normal capacity still allows eligible low-risk workers through scheduler gates.

## Phase 6: Learning Closure Proof

- [x] Prepare and drain a deterministic mock loop with maker and checker leases.
- [x] Move eligible loop to `ready_for_human_merge`.
- [x] Call `POST /api/swarms/evolution/close-loop`.
- [x] Assert closure creates eval run and reflection candidate.
- [x] Assert reusable lesson creates memory candidate.
- [x] Assert score regression creates repair work item.
- [x] Assert score improvement can create skill improvement work item.
- [x] Assert missing checker/gates/runtime evidence blocks closure.

Validation:

- [x] Closed loop metadata links loop, eval, reflection, memory and follow-up ids.
- [x] No automatic memory promotion occurs.
- [x] No auto-merge, push or deploy occurs.

## Phase 7: Mission Control Operator Flow

- [x] Add or finish action controls for OKF validate, sync dry-run, sync apply and close learning loop.
- [x] Add latest learning outcome panel with score delta and candidate links.
- [x] Add next safe action rendering from real API state.
- [x] Add dashboard fixture/test proving canonical label is `knowledge/`.
- [x] Add dashboard fixture/test proving `packages/knowledge` is not shown as production knowledge.

Validation:

- [x] `npm run build --workspace=@djimitflo/dashboard`
- [x] Operator can complete the flow without reading raw stdout.

## Phase 8: End-To-End Acceptance

- [x] Run OpenSpec validation.
- [x] Run focused server tests.
- [x] Run dashboard build.
- [x] Run end-to-end deterministic smoke.
- [x] Capture evidence ids and commands in the change evidence file.
- [x] Mark completed tasks only after evidence exists.

Validation commands:

- [x] `openspec validate prove-learning-flywheel-operator-loop --strict`
- [x] `openspec validate knowledge-runtime-learning-flywheel --strict`
- [x] `openspec validate real-worker-fleet-functionality-scale --strict`
- [x] `npm run test --workspace=@djimitflo/server -- knowledge-runtime-service.test.ts knowledge-capability-sync.test.ts goal-batch-service.test.ts learning-closure-service.test.ts swarm-resource-plan.test.ts`
- [x] `npm run type-check`
- [x] `npm run build --workspace=@djimitflo/dashboard`
- [x] `git diff --check`
