# Spec Delta — Agentic OS (Level-6)

## ADDED requirements

### Requirement: Competence-Per-Runtime Tracking
The system SHALL track competence per `(capability_id, runtime)`. `measureCompetence`
SHALL return per-runtime success_rate, p50_cost, p95_cost. `selectRuntime` SHALL pick
the runtime with the highest success_rate above a threshold (0.5) for the given
capability. If no per-runtime data exists, it SHALL fall back to the existing heuristic.

#### Scenario: Opencode chosen over codex based on competence
- GIVEN a capability with 3 codex runs (1 success, 2 fail) and 2 opencode runs (2 success)
- WHEN selectRuntime is called for this capability
- THEN opencode is selected (success_rate 1.0 > 0.33)

### Requirement: Skill Injection
The system SHALL inject matching skill procedures into maker assignments alongside
retrieved memory. A skill is a typed procedure with steps, precondition, and expected
effect. The maker assignment SHALL include: finding + skill procedure + retrieved memory.

#### Scenario: Maker sees skill procedure
- GIVEN a finding in a .ts file and a TypeScript-fix skill with procedure steps
- WHEN the maker assignment is prepared
- THEN the assignment includes the skill procedure steps (not just vector-memory)

### Requirement: Active Memory Curator
The memory_curator nested specialist SHALL actively distill rules, update trust scores,
and detect contradictions. The curator (not the proof-run-service) SHALL call
`distillFromRun` after each run.

#### Scenario: Curator distills after run
- GIVEN a completed run with evidence
- WHEN the memory_curator processes the run
- THEN a distilled rule is written to the procedural store
- AND the curator is observable in the trace spans (not the proof-run-service)

### Requirement: Specialised Capabilities
The system SHALL seed specialised capabilities (TypeScript-fix, Python-fix, Security-audit,
Docs-update, Test-write). `planLoopRun` SHALL match findings to capabilities by file type
and keyword. Each capability has its own measured competence.

#### Scenario: TypeScript finding routes to TypeScript-fix
- GIVEN a finding in a .ts file about a type error
- WHEN planLoopRun processes the finding
- THEN the finding is matched to the TypeScript-fix capability (not a generic one)

### Requirement: Meta-Evolution Loop
The system SHALL periodically evaluate: planner accuracy, rule accuracy, capability
usage. Dormant capabilities (0 runs in 30 days) SHALL be deprecated. Rules with ≥3
contradictions SHALL be demoted. A `meta_evolution` event SHALL be emitted on SSE.

#### Scenario: Dormant capability is pruned
- GIVEN a capability with 0 runs in 30 days
- WHEN the meta-evolution loop runs
- THEN the capability status changes to 'deprecated'
- AND a meta_evolution event is emitted

### Requirement: Adaptive Planner
The planner SHALL use per-runtime competence (G28) + distilled rules (G33) to make
assignments. The planner SHALL score `(capability, runtime)` by
`success_rate × rule_alignment / p50_cost`. The same error SHALL NOT recur — the planner
learns from observed outcomes.

#### Scenario: Planner adapts after failure
- GIVEN run 1 assigned a .ts finding to codex and it failed
- WHEN run 2 processes a similar .ts finding
- THEN the planner routes to opencode (if opencode has higher competence)
- AND the planner does NOT route to codex again for this finding type
