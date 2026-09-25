# Tasks

## Phase 1: OpenSpec Contract

- [x] Create `production-runtime-integration-certification` change.
- [x] Add proposal, design, tasks and requirement spec.
- [x] Add ordered `goals.batch.json`.
- [x] Add preview-only `run-goals-batch.mjs`.
- [x] Validate with `openspec validate production-runtime-integration-certification --strict`.

## Phase 2: Runtime Readiness Contract

- [x] Inspect current runtime contract and proof-run runtime logic.
- [x] Add or expose a readiness response for `codex` and `opencode`.
- [x] Include command, availability, status, evidence and blocked reasons.
- [x] Ensure readiness checks never start workers.
- [x] Add focused tests for available, unavailable and unsupported runtime cases.

Validation:

- [x] Readiness reports blocked reasons when runtime binary is unavailable.
- [x] Readiness returns start permission only when runtime contract is ok.

## Phase 3: Real Runtime Integration Smoke

- [x] Add `integration-spine-real-runtime-smoke.test.ts`.
- [x] Skip by default unless `RUN_REAL_RUNTIME_SMOKE=1`.
- [x] Use `REAL_RUNTIME=codex|opencode`, defaulting to `codex`.
- [x] Import a low-risk integration event into existing inbox.
- [x] Plan and prepare maker/checker leases with explicit real runtime.
- [x] Assert no worker starts during planning.
- [x] Drain worker pool through existing scheduler only.
- [x] Close loop learning after checker acceptance.

Validation:

- [x] Default test run reports skipped, not failed.
- [x] Opt-in run fails clearly if runtime readiness is blocked.
- [x] Opt-in run passes when runtime executes maker/checker successfully.

## Phase 4: Production Proof Certification

- [x] Run or extend `ProofRunService` with a real runtime.
- [x] Assert `proof_class` is `production`.
- [x] Assert `production_passed` is true for the certified run.
- [x] Assert `production_missing` is empty.
- [x] Assert real runtime usage, deterministic checks and sub-agent evidence are present.
- [x] Persist proof summary evidence.

Validation:

- [x] Mock proof remains `demo`.
- [x] Real runtime proof can become `production`.
- [x] Failed real runtime proof reports exact missing production criteria.

## Phase 5: Mission Control Production Truth

- [x] Extend Mission Control payload with production runtime certification state.
- [x] Show latest real runtime proof status.
- [x] Show requested runtime vs effective runtime.
- [x] Show `production_missing` reasons.
- [x] Show next safe action from API state.
- [x] Add dashboard model/render tests.

Validation:

- [x] Dashboard distinguishes mock proof from production runtime proof.
- [x] Dashboard renders missing/empty certification state without crashing.
- [x] Operator can identify next safe action without raw stdout.

## Phase 6: End-To-End Production Run

- [x] Run one bounded low-risk real runtime production certification.
- [x] Capture evidence ids in `evidence.md`.
- [x] Confirm no auto-merge, no deploy and no automatic memory promotion.
- [x] Confirm Mission Control shows production certification.
- [x] Run final validation commands.

Validation commands:

- [x] `openspec validate production-runtime-integration-certification --strict`
- [x] `openspec validate agentic-os-run-chain-proof --strict`
- [x] `npm run test --workspace=@djimitflo/server -- github-cocreate.test.ts swarm-resource-plan.test.ts integration-spine-service.test.ts integration-spine-smoke.test.ts`
- [x] `npm run test --workspace=@djimitflo/server -- integration-spine-real-runtime-smoke.test.ts`
- [x] `RUN_REAL_RUNTIME_SMOKE=1 REAL_RUNTIME=codex RUNTIME_ALLOW_SKIP_PERMISSIONS=true npm run test --workspace=@djimitflo/server -- integration-spine-real-runtime-smoke.test.ts`
- [x] `npm run test --workspace=@djimitflo/dashboard -- SwarmMissionControlPage.test.ts`
- [x] `npm run type-check`
- [x] `npm run build --workspace=@djimitflo/dashboard`
- [x] `git diff --check`
