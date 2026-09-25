# Tasks

## Phase 1: OpenSpec Scaffolding

- [x] Create `agentic-os-integration-spine` change.
- [x] Add proposal, design, tasks and requirement spec.
- [x] Add ordered `goals.batch.json`.
- [x] Add preview-only `run-goals-batch.mjs`.
- [x] Validate with `openspec validate agentic-os-integration-spine --strict`.

## Phase 2: Integration Inbox

- [x] Add canonical intake service over existing `work_items`.
- [x] Support dry-run normalization with zero writes.
- [x] Support idempotent apply by `source` and `source_ref`.
- [x] Store integration details under `metadata.integration`.
- [x] Add tests for GitHub issue, Telegram command, MCP drift, OKF drift and dashboard action shapes.

## Phase 3: Capability-Gated Connectors

- [x] Reuse existing `swarm_capabilities` and MCP permission tables for connector gates.
- [x] Block unvalidated or over-risk connector routing.
- [x] Allow validated low-risk connector events to create/propose work.
- [x] Add tests for unvalidated connector block and validated low-risk proposal.

## Phase 4: Plan And Prepare Chain

- [ ] Add operator-safe path from selected work item to goal, loop and maker/checker leases.
- [ ] Do not start workers during planning or preparation.
- [ ] Link source event and work item ids into loop and lease metadata.
- [ ] Add tests proving prepared leases remain prepared until scheduler call.

## Phase 5: Scheduler, Worker And Checker Proof

- [ ] Start eligible integration-origin worker only through existing worker pool scheduler.
- [ ] Run checker through existing checker bridge.
- [ ] Persist artifacts, gates, trace/checkpoint refs and checker verdict.
- [ ] Add smoke test proving worker/checker evidence links to source work item.

## Phase 6: Learning Closure

- [ ] Close integration-origin loop through existing learning closure.
- [ ] Create eval, reflection and optional memory candidate.
- [ ] Create repair work item on regression.
- [ ] Confirm no automatic durable memory promotion.
- [ ] Add tests for improved, regressed and missing-evidence closures.

## Phase 7: Mission Control

- [ ] Add Integration Spine panel to Mission Control.
- [ ] Show source event, work item, goal, loop, leases, gates, eval and learning candidates.
- [ ] Show capability/connector gate status and next safe action.
- [ ] Add dashboard test for rendering object-safe empty states.

## Phase 8: End-To-End Smoke

- [ ] Run deterministic mock-runtime smoke from imported integration event to learning closure.
- [ ] Capture evidence ids in test output or evidence file.
- [ ] Run validation commands from the test plan.

## Validation

- [x] `openspec validate agentic-os-integration-spine --strict`
- [x] `node openspec/changes/agentic-os-integration-spine/run-goals-batch.mjs --dry-run`
- [ ] `npm run test --workspace=@djimitflo/server -- github-cocreate.test.ts swarm-resource-plan.test.ts integration-spine-service.test.ts integration-spine-smoke.test.ts`
- [x] `npm run test --workspace=@djimitflo/server -- integration-spine-service.test.ts github-cocreate.test.ts`
- [x] `npm run type-check --workspace=@djimitflo/server`
- [ ] `npm run test --workspace=@djimitflo/dashboard -- SwarmMissionControlPage.test.ts`
- [ ] `npm run build --workspace=@djimitflo/dashboard`
- [ ] `npm run type-check`
- [ ] `git diff --check`
