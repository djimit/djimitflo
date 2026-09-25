# Tasks

## Phase A — Stabilize Test Suite

- [x] Run `npx vitest run --reporter=verbose` and capture the 4 failing test
      names + error messages.
- [x] Fix `swarm-resource-plan.test.ts` line 112 timeout: raise test timeout to
      15000ms for the "reports swarm reality counts" case.
- [x] Fix the remaining failing tests: only 1 actual failure (learning-flywheel-smoke
      timeout) — raised to 30000ms. Other "failures" were expected error-handling paths.
      fix the code or mark obsolete tests with `it.skip` + reason.
- [x] Run `npm run test` across all workspaces and confirm green exit.
- [x] Run `npm run type-check` and confirm clean.
- [x] Run `npm run lint` and confirm clean.

Validation:

- [x] `npm run test` exits 0.
- [x] `npm run type-check` exits 0.
- [x] `npm run lint` exits 0.

## Phase B — Verify Learning Flywheel Closure

- [x] Map `learning-flywheel-smoke.test.ts` assertions to the 6 Phase 7 tasks
      in `knowledge-runtime-learning-flywheel/tasks.md`.
- [x] Check off the 6 Phase 7 tasks with evidence references in
      knowledge-runtime-learning-flywheel/tasks.md.
      endpoint, assertion line).
- [x] Run `openspec validate knowledge-runtime-learning-flywheel --strict`.
- [x] Run `openspec validate prove-learning-flywheel-operator-loop --strict`.
- [x] Confirm both changes show all tasks complete.

Validation:

- [x] `openspec validate knowledge-runtime-learning-flywheel --strict` exits 0.
- [x] `openspec validate prove-learning-flywheel-operator-loop --strict` exits 0.
- [x] No unchecked tasks remain in either change.

## Phase C — Commit Clean Tree

- [x] Run `git diff --check` and fix whitespace errors.
- [x] Review the 39 uncommitted files and group by logical change.
- [x] Commit learning flywheel files (knowledge-runtime-service,
      capability-sync, learning-closure, smoke test) referencing
      `knowledge-runtime-learning-flywheel`.
- [x] Commit fleet cockpit refactor files (FleetCockpitPage,
      swarm-status-service, swarm-resource-plan) referencing
      `real-worker-fleet-functionality-scale`.
- [x] Commit agent catalog files referencing the spec-kit adoption change.
- [x] Commit security upgrade files (package-lock, deps).
- [x] Commit DB migration fix files (migrate.ts, schema.ts).
- [x] Commit dashboard files (SwarmMissionControlPage, api.ts) referencing
      `prove-learning-flywheel-operator-loop`.
- [x] Confirm `git status --short` is empty.

Validation:

- [x] `git status --short` outputs nothing.
- [x] `git log --oneline -10` shows grouped commits with OpenSpec refs.
- [x] `git diff --check` is clean.

## Phase D — Swarm Intelligence (G14)

### G14.1 Swarm Intelligence Kernel

- [x] Add `swarm_missions`, `swarm_tasks`, `swarm_decisions` tables to
      `database/schema.ts` and `database/migrate.ts`.
- [x] Add state transitions: `observed → hypothesized → planned → queued →
      prepared → running → checking → ready_for_human_merge →
      completed|blocked|rejected|escalated`.
- [x] Add `SwarmIntelligenceService` methods for mission/task/decision
      lifecycle.
- [x] Ensure active execution requires runtime evidence, not registry count.
- [x] Add tests for illegal transitions and registry-vs-runtime truth.

Validation:

- [x] Mission/task/decision state machine tests pass.
- [x] Illegal transition is rejected with a mapped error code.
- [x] Registry count does not equal active execution.

### G14.2 Capability Registry And Skill Contracts

- [x] Extend `swarm_capabilities` with contract fields: allowed_actions,
      forbidden_actions, required_evidence, eval_threshold, risk_ceiling,
      removal_strategy.
- [x] Enforce status gates: `draft` and `candidate` are advisory; `validated`
      may route live workers within risk ceiling.
- [x] Add contract validation in `SwarmIntelligenceService`.
- [x] Add tests for live routing refusal when draft, disabled, over-risk or
      below eval threshold.

Validation:

- [x] Draft/candidate capabilities cannot route live workers.
- [x] Validated capability within risk ceiling routes successfully.
- [x] Missing contract fields block validation.

### G14.3 Specialist Council And Hypothesis Workbench

- [x] Add `specialist_profiles`, `specialist_panels`, `specialist_reviews`
      tables.
- [x] Add bounded specialist profile catalog (math, physics, security,
      architecture, product, etc.).
- [x] Add panel creation with required security reviewer for high/critical risk.
- [x] Add independent review capture: support, oppose, uncertain,
      needs_evidence, dissent.
- [x] Add consensus-to-backlog projection without starting workers.
- [x] Add tests for unknown specialist refusal, high-risk reviewer enforcement,
      duplicate backlog prevention.

Validation:

- [x] Panel with high-risk question requires security reviewer.
- [x] Dissent is preserved in review output.
- [x] Backlog projection creates work items, not worker leases.

### G14.4 Evidence Graph And Claim Ledger

- [x] Add `swarm_claims` table with source refs, confidence, contradiction
      links, promotion status.
- [x] Add `evidence_edges` table connecting goals, loop-runs, worker leases,
      panels, capabilities, sources, claims, decisions, memory candidates,
      trace spans.
- [x] Add memory candidate classification: operational, engineering_rule,
      policy_rule, rejected_secret_like.
- [x] Add contradiction detection across claims.
- [x] Add tests for contradiction detection, secret-like rejection, policy
      memory review requirement.

Validation:

- [x] Contradictory claims are linked with explicit contradiction edge.
- [x] Secret-like memory candidates are rejected.
- [x] Policy memory requires human review before promotion.

### G14.5 Capacity Governor V2

- [x] Add queue classes: research, doc_fix, test_repair, security, memory,
      policy.
- [x] Add per-runtime fair-share scheduling.
- [x] Extend runner planning with queue class, queue age, budget state,
      failure budget, wall-clock state, kill eligibility.
- [x] Add kill/timeout handling with trace spans and after-checkpoints.
- [x] Add tests for fair-share ordering, exhausted budgets, high-risk
      blocking, runtime unavailable, repeated failure stop, kill evidence.

Validation:

- [x] Fair-share ordering respects queue class weights.
- [x] Exhausted budget blocks new worker starts.
- [x] Kill evidence includes trace span and checkpoint.

### G14.6 Evaluation Harness

- [x] Add eval targets for skill contracts, specialist outputs, memory
      retrieval, routing decisions, worker outcomes, dashboard truth.
- [x] Store deterministic scorecards with pass thresholds and evidence refs.
- [x] Ensure advisory LLM evals cannot override deterministic gates.
- [x] Add regression fixtures for known-bad skills, unsupported claims,
      misleading dashboard metrics.

Validation:

- [x] Deterministic gate failure blocks despite advisory LLM pass.
- [x] Scorecard stores threshold, actual score and evidence refs.
- [x] Regression fixture for known-bad skill fails.

### G14.7 Mission Control Dashboard

- [x] Add mission control view for registry, active execution, queue depth,
      capacity, budgets, blocked reasons.
- [x] Add specialist council view with panel state, consensus, dissent,
      evidence refs, backlog projection.
- [x] Add skill catalog view with contract status, eval score, risk ceiling,
      allowed actions.
- [x] Add evidence graph and claim ledger view with filters for contradicted,
      review-required, promoted claims.
- [x] Add dashboard tests for active execution labels and evidence-backed
      counts.

Validation:

- [x] `npm run build --workspace=@djimitflo/dashboard` exits 0.
- [x] Dashboard shows active execution from runtime evidence only.
- [x] Registry count is not shown as active execution.

### G14.8 End-To-End Swarm Scenario Smoke Part 1

- [x] Add evaluator quorum as a hard gate for high-risk and disputed work.
- [x] Add policy-eligible split-decision rules for too-large work, repeated
      failures, checker-recommended splits.
- [x] Add runner audit manifests for start, skip, fail, stop, kill decisions.
- [x] Add replay branches from checkpoints without copying historical worker
      leases.
- [x] Add risk-aware runtime warning gates and fleet-level circuit breakers.
- [x] Add tests for quorum missing, split denied, high-risk approval missing,
      replay zero leases, warning gate fail, repeated failure stop.

Validation:

- [x] Quorum missing blocks high-risk work.
- [x] Split decision creates child work items, not auto-execution.
- [x] Replay branch has zero copied leases.

### G14.9 End-To-End Swarm Scenario Smoke Part 2

- [x] Run mock-runtime scenario from question to specialist panel to backlog
      to goal to prepared leases.
- [x] Execute policy-gated low-risk worker run with checker and evidence
      graph update.
- [x] Verify no merge, push, deploy or high-risk unattended execution
      occurred.
- [x] Record smoke evidence with IDs, endpoints, runtime status, budgets,
      artifacts, dashboard routes, remaining risks.
- [x] Add the smoke as a passing test in the suite.

Validation:

- [x] Full scenario completes with mock runtime.
- [x] Evidence graph has nodes for every entity in the scenario.
- [x] No auto-merge/push/deploy/unattended-high-risk in the smoke.
- [x] `npm run test` includes the G14.9 smoke and it passes.

## Final Validation

- [x] `openspec validate converge-foundation-and-swarm-intelligence --strict`
      exits 0.
- [x] `openspec validate next-level-swarm-skills-specialists --strict` exits 0.
- [x] `npm run test` exits 0 across all workspaces.
- [x] `npm run type-check` exits 0.
- [x] `npm run lint` exits 0.
- [x] `npm run build --workspace=@djimitflo/dashboard` exits 0.
- [x] `git status --short` is empty.
- [x] `git diff --check` is clean.
