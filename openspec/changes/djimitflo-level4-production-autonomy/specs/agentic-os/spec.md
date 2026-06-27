# Spec Delta — Agentic OS (Level-4)

## ADDED requirements

### Requirement: Memory Store Classification
The system SHALL classify all memory into one of four stores: episodic, procedural,
semantic, or working. Each memory row in `swarm_memory` and each qdrant point SHALL carry
a `store` field. The memory_curator SHALL route the flywheel write to the correct store
based on the evidence type. Retrieval (`searchQdrantSwarm`) SHALL filter by store when
the caller specifies a store preference.

#### Scenario: Procedural memory is retrievable by capability
- GIVEN a run completes with a distilled rule written to the `procedural` store
- WHEN a later run's maker requests procedural knowledge for that capability
- THEN the rule is retrieved with `store: 'procedural'` in the payload
- AND episodic memories from the same run are NOT returned

### Requirement: Resource Envelope Coupling
The system SHALL couple the AIMD concurrency hard cap to
`fleetPools().recommended_concurrency` via an injected `ConcurrencyAdvisor` callback.
The hard cap SHALL be `min(env_cap, fleet_recommended)`. The resource envelope SHALL
include dollars, CPU, memory, and GPU in addition to tokens and wall-clock.

#### Scenario: Hard cap tracks fleet capacity
- GIVEN `fleetPools().recommended_concurrency` returns 6 and `RUNTIME_MAX_CONCURRENCY=8`
- WHEN the AIMD controller initializes
- THEN the hard cap is 6 (not 8)
- AND the controller never exceeds 6 concurrent runtime leases

### Requirement: Graceful Scale-Down
On budget exhaustion or circuit-break, the system SHALL stop accepting new leases, wait
up to `drain_timeout_ms` for in-flight leases to complete, checkpoint incomplete leases,
and SIGTERM (not SIGKILL) child processes. The run SHALL be marked `interrupted` with
`interrupted_reason: 'budget_drain'`.

#### Scenario: In-flight lease is checkpointed on budget drain
- GIVEN a run with 2 in-flight maker leases and the dollar budget is exhausted
- WHEN the drain logic fires
- THEN no new leases are accepted
- AND in-flight leases receive up to 60s to complete
- AND incomplete leases are checkpointed + SIGTERM'd (not SIGKILL'd)
- AND the run is `interrupted` (resumable)

### Requirement: Crash Recovery with Resume
On server restart, the system SHALL detect interrupted runs, load the last checkpoint,
determine completed vs in-flight findings, re-queue in-flight findings as new leases,
and resume the run. After `max_resume_attempts` (default 3) interrupted resumes, the run
SHALL be marked `failed` (bounded-fail, no infinite retry).

#### Scenario: Run resumes after restart
- GIVEN a run is interrupted mid-maker (server killed)
- WHEN the server restarts
- THEN the run is resumed from the last checkpoint
- AND completed findings are NOT re-executed
- AND in-flight findings are re-queued as new leases

### Requirement: Runtime-Adaptive Selection
The planner SHALL select the runtime per finding by `(capability, competence, cost,
sovereignty)`. Sovereign goals SHALL route to pi. Lightweight findings (p50_tokens <
threshold) SHALL route to opencode. Complex/high-competence findings SHALL route to codex.

#### Scenario: Sovereign goal routes to pi
- GIVEN a goal with `sovereign: true`
- WHEN the planner emits the capability DAG
- THEN all findings are assigned runtime `pi`
- AND no codex or opencode leases are created

### Requirement: Memory Distillation
The memory_curator SHALL distill actionable rules from run evidence (not run-summaries).
The distilled rule SHALL be written to the `procedural` store with provenance + trust.
The rule SHALL go through the same evidence-gated promotion as skills (G1): checker
verifies, trust decay + contradiction apply.

#### Scenario: Distilled rule is written after a run
- GIVEN a run completes with `production_passed=true`
- WHEN the memory_curator processes the run evidence
- THEN an actionable rule is written to the `procedural` store
- AND the rule carries `provenance_run` + `evidence_refs` + `trust`
- AND the rule is retrievable by capability + precondition in a later run

### Requirement: Skill Composition
The system SHALL support composed skills: chains of atomic skills with inter-skill
handoff. A composed skill SHALL be promoted when all atomic skills are `validated` AND
the chain has ≥N validated runs. The planner SHALL be able to emit a composed skill as a
single DAG node (expanded at execution time).

#### Scenario: Composed skill is promoted and used
- GIVEN two atomic skills (`diagnose`, `fix`) are both `validated`
- AND the chain `diagnose → fix` has ≥3 validated runs
- WHEN the planner processes a new goal requiring both capabilities
- THEN the planner emits the composed skill as a single DAG node
- AND the node is expanded to `diagnose → fix` at execution time

### Requirement: Dollar Economy
The cost model SHALL be dollar-denominated. Each runtime's cost SHALL be computed from
token usage × price per token. The planner SHALL allocate the goal's dollar budget across
the DAG (bounded knapsack). The efficiency metric SHALL be `verified_artifacts / dollar`.
The system SHALL refuse a goal whose expected cost exceeds its value.

#### Scenario: Goal is refused for insufficient budget
- GIVEN a goal with `dollar_budget: 1` and 5 findings each costing ~$0.50
- WHEN the planner allocates the budget
- THEN only 2 findings fit the budget
- AND the goal is flagged `budget_insufficient` (deferred or refused)

### Requirement: Live Observability
The system SHALL provide an SSE stream (`GET /api/observability/stream`) emitting
real-time events: `aimd_state`, `trust_change`, `capability_transition`,
`lease_lifecycle`, `budget_burn`, `convergence`. Events SHALL arrive within 1s of the
action. The stream SHALL use a bounded buffer with a `dropped_events` counter.

#### Scenario: SSE client receives real-time AIMD adjustment
- GIVEN an SSE client connected to `/api/observability/stream`
- WHEN a runtime lease completes and `adjustConcurrency` fires
- THEN the client receives an `aimd_state` event within 1s
- AND the event includes `{ dynamicLimit, active, queue_depth, hard_cap }`

### Requirement: Cross-Fleet Knowledge Bus
The system SHALL provide an in-process `KnowledgeBus` with `publish(claim)` and
`subscribe(capabilityId, callback)`. `createClaim` SHALL call `bus.publish`. HTTP
endpoints (`POST /api/knowledge/publish`, `GET /api/knowledge/subscribe/:capabilityId`)
SHALL be scaffolded for future federation.

#### Scenario: Subscriber receives claim in real-time
- GIVEN a planner subscribed to capability `debugging`
- WHEN a claim is created for capability `debugging` in another run
- THEN the subscriber's callback is invoked with the claim
- AND the claim includes `trust`, `provenance_run`, `evidence_refs`

### Requirement: Continuous Operation
The system SHALL run a `LoopDaemon` that maintains a goal queue, sorts by
(risk desc, value desc, cost asc), and executes goals continuously (decompose → execute →
certify → learn → persist). The daemon SHALL start on server boot after crash recovery.

#### Scenario: Two goals execute in priority order
- GIVEN two pending goals: goal A (risk: high, value: 10) and goal B (risk: low, value: 5)
- WHEN the daemon starts
- THEN goal A executes first (higher risk + value)
- AND goal B executes after goal A completes or bounded-fails

### Requirement: Secret Rotation
The system SHALL NOT contain any hardcoded API keys in git history. The Qdrant API key
SHALL be rotated. Old keys SHALL be purged from all git history via `git filter-repo`.

#### Scenario: Old key is not in history
- GIVEN the workstation's DjimitKBWiki + FastAPI MCP commits contained the old Qdrant key
- WHEN `git filter-repo --replace-text` is run + the key is rotated
- THEN `git log -p | grep <old_key>` returns no matches
- AND the new key works across all consumers
