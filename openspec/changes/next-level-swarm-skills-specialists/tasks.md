# Tasks

## G14.1 Swarm Intelligence Kernel

- [x] Define mission, swarm task and decision-state models linking goals, loop-runs, panels, claims, capabilities and worker leases.
- [x] Add state transitions for `observed -> hypothesized -> planned -> queued -> prepared -> running -> checking -> ready_for_human_merge -> completed|blocked|rejected|escalated`.
- [x] Ensure active execution requires runtime evidence, not registry count.
- [x] Add tests for illegal transitions and registry-versus-runtime truth.

## G14.2 Capability Registry And Skill Contracts

- [x] Add capability registry tables or service models for skills, specialist agents, runtime adapters, harnesses, memory sources and dashboard actions.
- [x] Enforce status gates: `draft` and `candidate` are advisory only; `validated` may route live workers within risk ceiling.
- [x] Add contract validation for allowed actions, forbidden actions, required evidence, schemas, eval thresholds and removal strategy.
- [x] Add tests for live routing refusal when a capability is draft, disabled, over-risk or below eval threshold.

## G14.3 Specialist Council And Hypothesis Workbench

- [x] Add bounded specialist profile catalog.
- [x] Add panel creation with required security reviewer for high/critical risk.
- [x] Add independent review capture with support, oppose, uncertain, needs_evidence and dissent.
- [x] Add consensus-to-backlog projection without starting workers.
- [x] Add tests for unknown specialist refusal, high-risk reviewer enforcement and duplicate backlog prevention.

## G14.4 Evidence Graph And Claim Ledger

- [x] Add claim ledger records with source refs, confidence, contradiction links and promotion status.
- [x] Add evidence graph edges across goal, loop-run, worker lease, panel, capability, source, claim, decision, memory candidate and trace span.
- [x] Add memory candidate classification: operational, engineering rule, policy rule, rejected secret-like.
- [x] Add tests for contradiction detection, secret-like rejection and policy memory review requirement.

## G14.5 Capacity Governor V2

- [x] Add queue classes and per-runtime fair-share scheduling.
- [x] Extend runner planning with queue class, queue age, budget state, failure budget, wall-clock state and kill eligibility.
- [x] Add kill/timeout handling with trace spans and after-checkpoints.
- [x] Add tests for fair-share ordering, exhausted budgets, high-risk blocking, runtime unavailable, repeated failure stop and kill evidence.

## G14.6 Evaluation Harness

- [x] Add eval targets for skill contracts, specialist outputs, memory retrieval, routing decisions, worker outcomes and dashboard truth.
- [x] Store deterministic scorecards with pass thresholds and evidence refs.
- [x] Ensure advisory LLM evals cannot override deterministic gates.
- [x] Add regression fixtures for known-bad skills, unsupported claims and misleading dashboard metrics.

## G14.7 Mission Control Dashboard

- [x] Add mission control view for registry, active execution, queue depth, capacity, budgets and blocked reasons.
- [x] Add specialist council view with panel state, consensus, dissent, evidence refs and backlog projection.
- [x] Add skill catalog view with contract status, eval score, risk ceiling and allowed actions.
- [x] Add evidence graph and claim ledger view with filters for contradicted, review-required and promoted claims.
- [x] Add dashboard tests for active execution labels and MacBook cockpit wording.

## G14.8 End-To-End Swarm Scenario Smoke

- [x] Add evaluator quorum as a hard gate for high-risk and disputed work.
- [x] Add policy-eligible split-decision rules for too-large work, repeated failures and checker-recommended splits.
- [x] Add runner audit manifests for start, skip, fail, stop and kill decisions.
- [x] Add replay branches from checkpoints without copying historical worker leases.
- [x] Add risk-aware runtime warning gates and fleet-level circuit breakers.
- [x] Add tests for quorum missing, split denied, high-risk approval missing, replay zero leases, warning gate fail and repeated failure stop.

## G14.9 End-To-End Swarm Scenario Smoke

- [x] Run mock-runtime scenario from question to specialist panel to backlog to goal to prepared leases.
- [x] Execute policy-gated low-risk worker run with checker and evidence graph update.
- [x] Verify no merge, push, deploy or high-risk unattended execution occurred.
- [x] Record smoke evidence with IDs, endpoints, runtime status, budgets, artifacts, dashboard routes and remaining risks.
