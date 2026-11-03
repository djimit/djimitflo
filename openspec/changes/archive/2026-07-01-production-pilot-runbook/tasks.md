# Tasks

## Phase 1: OpenSpec Contract

- [x] Create `production-pilot-runbook` change.
- [x] Add proposal, design, tasks, spec, goals batch and preview helper.
- [x] Validate with `openspec validate production-pilot-runbook --strict`.

## Phase 2: Operator Runbook

- [x] Add `runbook.md`.
- [x] Include preflight, run, close-loop, dashboard and stop conditions.
- [x] Keep it executable from existing APIs/CLI commands.

Validation:

- [x] Runbook references only existing or planned endpoints.
- [x] Runbook includes no auto-merge, deploy or auto-promotion step.

## Phase 3: Pilot Metrics Contract

- [x] Inspect Mission Control and Integration Spine payloads.
- [x] Define the smallest pilot metrics read-model.
- [x] Reuse existing metadata for `pilot_run_id` where possible.
- [x] Add API/service only if existing payload cannot expose the metrics.

Validation:

- [x] Metrics link source event, work item, goal, loop, leases and closure.
- [x] Metrics include success, timing, checker rejection and intervention fields.

## Phase 4: Three Pilot Runs

- [x] Run pilot 1 on a bounded low-risk item.
- [ ] Run pilot 2 on a bounded low-risk item.
- [ ] Run pilot 3 on a bounded low-risk item.
- [x] Capture evidence ids and outcomes in `evidence.md`.

Validation:

- [ ] Each run uses explicit real runtime or records blocked readiness.
- [ ] Each run closes learning or records exact blocked reason.
- [x] No automatic durable memory promotion occurs.

## Phase 5: Mission Control Demo Truth

- [x] Ensure Mission Control shows latest pilot chain.
- [x] Show pilot metrics summary and next safe action.
- [x] Add dashboard test only if UI payload/rendering changes.

Validation:

- [x] Operator can demo the pilot without reading raw stdout.
- [x] Empty or failed pilot state renders without crashing.

## Phase 6: Final Gates

- [x] `openspec validate production-pilot-runbook --strict`
- [x] `node openspec/changes/production-pilot-runbook/run-goals-batch.mjs --dry-run`
- [x] Focused server tests for touched services/routes.
- [x] Focused dashboard tests if dashboard changes.
- [x] `npm run type-check`
- [x] `git diff --check`
