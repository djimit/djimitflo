# Tasks

## G15.1 Security Boundary And Provenance Baseline

- [x] Constrain OKF drift/sync inputs to configured OKF roots and workspace roots using canonical realpath checks.
- [x] Remove arbitrary filesystem query paths from OKF drift endpoints, or require explicit allowlisted root ids instead of raw paths.
- [x] Add a shared secret-like payload detector for claims, evidence, traces, manifests and memory candidates.
- [x] Replace broad `create:task` checks with scoped permissions: `write:capability`, `write:claim`, `write:governance`, `write:runner_manifest` and `write:swarm_action`.
- [ ] Move cockpit/workstation labels to runtime node configuration or heartbeat-derived inventory.
- [x] Add evidence-ref resolver helpers that verify record kind, existence, actor, timestamp, sensitivity and route eligibility.
- [x] Add tests for OKF path escape refusal, secret-like rejection, scoped permission refusal and runtime node label fallback.

## G15.2 Capability Promotion And Router Enforcement

- [x] Split capability candidate creation from validated promotion.
- [x] Require promotion evidence refs, eval scorecard refs, owner, version, risk ceiling, allowed actions, forbidden actions, eval threshold and removal strategy.
- [x] Make eval score below threshold a hard fail in capability evaluation.
- [x] Require high/critical capability promotion to include security checker and human approval refs.
- [x] Route `startNextWorker` and worker drain selection through validated capability contracts.
- [x] Persist blocked routing reasons when capability status, risk ceiling, runtime status, eval threshold or required evidence fails.
- [x] Add tests for draft/candidate routing refusal, below-threshold hard fail, high-risk promotion refusal and successful low-risk routing.

## G15.3 Governance Enforcement Layer

- [ ] Add an enforcement decision service for worker, loop, memory and dashboard mutating actions.
- [ ] Stop accepting spoofable governance booleans from request payloads; accept refs and resolve persisted evidence.
- [ ] Enforce maker/checker/security checker/quorum/human approval refs against stored records and policy version.
- [x] Integrate enforcement into `verifyLoopRun`, `completeLoopRun`, `startNextWorker`, `drainWorkerPool`, `stop/kill` and memory promotion.
- [ ] Ensure `ready_for_human_merge`, `human_approved` and `completed` remain distinct states.
- [x] Write trace spans for each allowed, blocked, advisory or human-required enforcement decision.
- [x] Add tests for spoofed governance payload refusal, missing quorum block, missing human approval block and low-risk allowed path.

## G15.4 Claim Ledger V2 And Evidence Provenance

- [x] Add typed claim fields: `subject_ref`, `predicate`, `object`, `scope`, `confidence`, `valid_from`, `valid_until`, `status`, evidence refs and sensitivity.
- [x] Replace same-subject contradiction heuristics with explicit `supports`, `refines` and `contradicts` edges plus typed predicate/scope rules.
- [x] Require evidence refs to resolve before a claim can become supported, promoted, route-influencing or memory-influencing.
- [ ] Add specialist-review-to-claim extraction that leaves unsupported claims as proposed.
- [ ] Add retention/deletion metadata for evidence records and memory candidates.
- [ ] Add tests for multiple supported facts on one subject, explicit contradiction, unsupported claim, expired claim and sensitive evidence rejection.

## G15.5 Evidence Graph Lineage Resolver

- [x] Add graph edges across specialist panel, review, claim, backlog item, goal, loop run, worker lease, trace span, checkpoint, runner manifest and memory candidate.
- [x] Add lineage resolver APIs for forward and reverse traversal.
- [x] Add evidence graph summaries for dashboard cards and review bundles.
- [ ] Ensure graph traversal cannot expose records outside the caller permission scope.
- [ ] Add tests for panel-to-memory lineage, lease-to-claim reverse lookup, missing edge handling and permission-filtered graph output.

## G15.6 Runner Manifest Auto-Write

- [x] Move runner manifest creation into runner action paths for plan, start, skip, stop, kill, timeout, failure, completion and drain summary.
- [x] Require real loop-run id, lease id, action, actor, capacity snapshot, budget snapshot and enforcement decision for each manifest.
- [x] Make manifests append-only and reject direct API assertion of completed runner actions.
- [ ] Attach stdout/stderr/artifact refs and token usage parsed from runtime output when available.
- [ ] Write before/after checkpoint refs around worker execution.
- [ ] Add tests for auto-written manifests, spoofed manifest refusal, timeout manifest, killed worker manifest and completion manifest.

## G15.7 Capacity Governor Live Scheduler

- [x] Implement queue classes with configurable fair-share weights and starvation protection.
- [ ] Enforce runtime concurrency slots per adapter and per risk class.
- [ ] Enforce token budget, wall-clock budget, retry budget and failure budget before worker start.
- [ ] Add process-aware stop/kill adapters for Codex/OpenCode runtime sessions.
- [x] Add fleet circuit breakers for repeated maker failures, checker rejections, runtime warnings and timeouts.
- [x] Record capacity snapshots, budget snapshots and selected/blocked reasons in traces and manifests.
- [ ] Add tests for fair-share ordering, exhausted token budget, exhausted wall-clock budget, repeated failure breaker, runtime unavailable and stop/kill evidence.

## G15.8 OKF Skill Sync And Hypothesis Workbench

- [ ] Index configured OKF skill roots into capability candidates with path, owner, version, actions, gates and validation report refs.
- [x] Keep sync dry-run by default and require explicit apply action with scoped permission.
- [ ] Persist specialist profile registry versions and store profile version on panel reviews.
- [ ] Add hypothesis entities with evidence plan, falsification signal, stop condition, owner capability and projection state.
- [ ] Add panel-to-backlog and hypothesis-to-goal projection without starting workers.
- [ ] Add tests for draft skill advisory-only behavior, validated skill eligibility, profile version persistence and hypothesis stop-condition enforcement.

## G15.9 Mission Control Drill-Through And Actions

- [x] Add drill-through links from dashboard metrics to capabilities, claims, panels, backlog items, goals, loops, leases, traces, checkpoints, manifests and memory candidates.
- [ ] Add gated operator actions for capability promotion, claim resolution, panel projection, goal creation, start-next, drain, stop/kill and manifest review.
- [ ] Show disabled action state with exact blocked reasons from enforcement decisions.
- [ ] Separate MacBook cockpit, workstation execution node, registry state, prepared leases and active runtime evidence in the UI.
- [ ] Avoid duplicate runtime status probes inside a single mission-control request by caching or passing the status snapshot.
- [ ] Add dashboard tests for drill-through, disabled blocked actions, active execution truth and runtime-node labels.

## G15.10 End-To-End Scenario And Runtime Smoke

- [ ] Add a mock-runtime scenario: question to hypothesis, panel, claims, backlog, goal, prepared lease, scheduler plan, worker, checker, manifest, memory candidate and dashboard proof.
- [ ] Verify the mock scenario writes trace spans, checkpoints, runner manifests, evidence graph edges and blocked/allowed governance decisions.
- [ ] Run a bounded Codex worker smoke after the mock scenario is green.
- [ ] Run a bounded OpenCode worker smoke after the Codex smoke is green or record an explicit runtime-unavailable blocked reason.
- [ ] Store evidence ids, endpoints, runtime status, stdout/stderr/artifact refs, usage parse results, budgets and remaining risks in the change evidence file.
- [ ] Verify no merge, push, deploy, high-risk unattended execution or automatic policy memory promotion occurred.
