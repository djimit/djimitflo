# Design

## Design Options

### Option A: Swarm Kernel

One central kernel owns planning, routing, capacity and completion. Every goal becomes a mission; every mission routes through a fixed state machine.

Strengths:

- Easy to reason about.
- Strongest policy enforcement.
- Clear API surface for dashboard and worker pool.

Weaknesses:

- Can become a large coordinator with too much responsibility.
- Harder to evolve specialist-agent behavior independently.

Best use:

- Worker lease lifecycle, queue classes, capacity and policy gates.

### Option B: Skill Mesh

Skills, specialist profiles and runtime adapters are first-class capabilities. The orchestrator selects capabilities by contract, score, risk class and evidence requirements.

Strengths:

- Makes skills measurable instead of decorative.
- Supports adding specialist knowledge without changing the whole scheduler.
- Good fit for eval harnesses and gradual promotion.

Weaknesses:

- Requires strict contract validation or capability drift becomes invisible.
- Needs deprecation/removal paths for bad skills.

Best use:

- Capability registry, skill routing, specialist profiles and eval scoring.

### Option C: Specialist Council

Complex work starts as a question or hypothesis. A panel of specialists independently reviews evidence, proposes experiments, records disagreement and projects valuable work to backlog.

Strengths:

- Useful for research, architecture, science-style reasoning and ambiguous decisions.
- Preserves dissent instead of flattening everything into a single LLM answer.
- Turns non-code thinking into auditable backlog.

Weaknesses:

- Can burn tokens unless bounded by evidence plans and stop conditions.
- Not suitable as the direct execution path for code changes.

Best use:

- Hypothesis workbench, claim ledger, memory synthesis and strategic analysis.

## Recommendation

Build a hybrid:

- **Swarm Kernel** for leases, queues, budgets, runtime evidence and policy.
- **Skill Mesh** for capability discovery, route selection and eval-based promotion.
- **Specialist Council** for multi-disciplinary analysis, hypotheses, critique and backlog projection.

This keeps execution closed-loop and auditable, while allowing open-loop discovery and specialist reasoning to feed the backlog.

## Core Concepts

### Capability Registry

Capabilities are typed records for:

- `skill`
- `specialist_agent`
- `runtime_adapter`
- `deterministic_harness`
- `memory_source`
- `dashboard_action`

Each capability has:

- `id`
- `kind`
- `owner`
- `version`
- `status`: `draft`, `candidate`, `validated`, `deprecated`, `disabled`
- `risk_ceiling`: `low`, `medium`, `high`, `critical`
- `input_schema_ref`
- `output_schema_ref`
- `allowed_actions`
- `forbidden_actions`
- `required_evidence`
- `eval_score`
- `eval_threshold`
- `cost_model`
- `removal_strategy`

Only `validated` capabilities can route live worker execution. Draft and candidate capabilities can run in planning, dry-run or advisory mode only.

### Specialist Profiles

Specialists are not magic personas. They are bounded capability profiles with evidence rules and output schemas.

Initial catalog:

- `mathematician`: formalization, invariants, scoring, optimization, proof gaps.
- `physicist`: systems dynamics, resource models, feedback loops, stability.
- `biologist`: adaptation, selection pressure, ecology of agents, resilience.
- `psychologist`: cognitive load, operator behavior, escalation fatigue.
- `behavioral_scientist`: incentives, adoption, anti-pattern detection, decision quality.
- `philosopher`: epistemology, claim quality, ethics, ambiguity, definitions.
- `security_reviewer`: threat modeling, auth, secrets, capability boundaries.
- `systems_architect`: interfaces, failure domains, scale constraints.
- `product_strategist`: value scoring, backlog prioritization, user impact.
- `data_scientist`: metrics, experiment design, statistical validity.

Every profile defines forbidden claims, required evidence and a maximum autonomy level.

### Hypothesis Workbench

The workbench turns high-level questions into bounded decision artifacts:

1. Intake question or observation.
2. Evidence plan.
3. Specialist panel assignment.
4. Independent reviews.
5. Consensus with dissent preserved.
6. Confidence and uncertainty.
7. Backlog projection.
8. Optional goal creation.
9. Optional worker lease preparation.

No worker is started during hypothesis workbench analysis.

### Evidence Graph And Claim Ledger

The evidence graph connects:

- goal
- loop-run
- worker lease
- specialist panel
- capability
- skill
- source
- claim
- evidence
- decision
- backlog item
- memory candidate
- trace span
- checkpoint

The claim ledger stores claim state:

- `proposed`
- `supported`
- `contradicted`
- `resolved`
- `rejected`
- `promoted`

Claims require source references before they can influence routing, memory or backlog priority.

### Capacity Governor V2

The governor selects work by queue class and runtime truth:

- Queue classes: `research`, `doc_fix`, `small_code_fix`, `test_repair`, `refactor`, `security_review`, `memory_synthesis`, `policy_review`, `experiment`.
- Runtime pools: Codex, OpenCode, mock, future adapters.
- Inputs: CPU threads, load, memory, disk, active executions, runtime contract status, budget state, queue age, risk class and human/security gates.
- Outputs: eligible, queued, blocked, running, killed and completed decisions with reasons.

Runner decisions always write trace spans.

### Evaluation Harness

The harness evaluates:

- skill contract validity
- specialist profile output quality
- memory retrieval relevance
- claim ledger consistency
- routing decision quality
- worker outcome quality
- dashboard truthfulness

Evaluation is deterministic where possible and advisory where LLM judgment is unavoidable. Advisory evals cannot override deterministic gates.

### Dashboard Mission Control

Mission Control shows:

- Swarm registry state.
- Live active execution evidence.
- Queue depth by risk, runtime and class.
- Prepared leases.
- Running worker PIDs/session refs when available.
- Blocked reasons.
- Token and wall-clock budgets from actual runtime usage.
- Specialist panels and decisions.
- Claim ledger changes.
- Skill eval status.
- Next safe action.

Dashboard copy must never imply the MacBook is executing workers when the workstation is the execution node.

## Implementation Slices

### G14.1 Swarm Intelligence Kernel

Create the mission/task model and state transitions that link goals, panels, capabilities, claims and worker leases.

### G14.2 Capability Registry And Skill Contracts

Add typed capability contracts, status transitions, eval metadata and routing constraints.

### G14.3 Specialist Council And Hypothesis Workbench

Add specialist catalog, panel creation, independent reviews, consensus, dissent and backlog projection.

### G14.4 Evidence Graph And Claim Ledger

Add claim/evidence persistence, contradiction detection and governed memory candidates.

### G14.5 Capacity Governor V2

Add queue classes, fair-share scheduling, runtime concurrency, budget/failure gates and kill handling.

### G14.6 Evaluation Harness

Add deterministic evals for capabilities, specialists, memory, routing and dashboard truth.

### G14.7 Mission Control Dashboard

Add high-density dashboard views for swarm reality, capacity, specialist panels, claim ledger and next safe action.

### G14.8 Decision Governance Harness

Add evaluator quorum, split-decision eligibility, runtime warning gates, audit manifests, replay lineage and fleet-level circuit breakers.

### G14.9 End-To-End Swarm Scenario Smoke

Run a bounded scenario: question to specialist panel, panel to backlog, backlog to goal, goal to prepared leases, policy-gated execution, checker verdict, evidence graph, memory candidate and dashboard proof.

## Validation Strategy

- OpenSpec strict validation.
- Node syntax validation for batch runner.
- `/goals` dry-run.
- Unit tests for state transitions and capability routing.
- API tests for registry, panel, claim ledger and capacity governor.
- Dashboard tests for truth labels and blocked reasons.
- Smoke test with mock runtime before Codex/OpenCode runtime.
- Real runtime smoke only after policy-gated plan is green.
