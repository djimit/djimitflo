# Tasks

## Phase 1: OpenSpec Scaffolding

- [x] Create `knowledge-runtime-learning-flywheel` change.
- [x] Add proposal, design, tasks and requirement spec.
- [x] Add ordered `goals.batch.json`.
- [x] Add `run-goals-batch.mjs` dry-run helper.

## Phase 2: Canonical OKF Runtime

- [x] Add `KnowledgeRuntimeService`.
- [x] Resolve canonical OKF from `OKF_BASE` or repo `knowledge/`.
- [x] Stop runtime services from silently defaulting production knowledge to `packages/knowledge`.
- [x] Add `GET /api/swarms/knowledge/runtime`.
- [x] Extend OKF drift with canonical path mismatch and projection status.

## Phase 3: Capability Sync

- [x] Parse OKF markdown/frontmatter with Node/fs only.
- [x] Add dry-run sync result with create/update/block counts.
- [x] Add apply mode that upserts `swarm_capabilities`.
- [x] Store source path, content hash and missing contract fields in metadata.

## Phase 4: Learning Closure

- [x] Add close-loop endpoint after loop execution.
- [x] Require maker/checker/gate/runtime evidence before closure.
- [x] Create eval, reflection and memory candidate.
- [x] Create repair work item on score regression.
- [x] Create skill improvement work item on score improvement.

## Phase 5: Special Agents And Skills

- [x] Load OKF-backed specialist profiles when valid.
- [x] Keep static specialist catalog fallback.
- [x] Preserve high-risk `security_reviewer` requirement.
- [x] Keep candidate/draft capabilities from routing live workers through status/eval gates.

## Phase 6: Dashboard Proof

- [x] Add Knowledge Runtime panel to Mission Control.
- [x] Show canonical OKF state, sync drift, latest closure score and next safe action.
- [x] Add dashboard type-check/build evidence.

## Phase 7: End-To-End Smoke

- [x] Validate OKF.
- [x] Sync capabilities dry-run.
- [x] Apply capability sync.
- [x] Prepare and drain a mock loop.
- [x] Close loop learning.
- [x] Confirm reflection and memory candidate without automatic promotion.

## Validation

- [x] `openspec validate knowledge-runtime-learning-flywheel --strict`
- [x] `npm run test --workspace=@djimitflo/server -- knowledge-runtime-service.test.ts`
- [x] `npm run test --workspace=@djimitflo/server -- knowledge-capability-sync.test.ts`
- [x] `npm run test --workspace=@djimitflo/server -- learning-closure-service.test.ts`
- [x] `npm run type-check`
- [x] `npm run build --workspace=@djimitflo/dashboard`
- [x] `node --check openspec/changes/knowledge-runtime-learning-flywheel/run-goals-batch.mjs`
- [x] `node openspec/changes/knowledge-runtime-learning-flywheel/run-goals-batch.mjs --dry-run`
- [x] `git diff --check`
