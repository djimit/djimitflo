## ADDED Requirements

### Requirement: Skills are typed capabilities promoted from evidence

The system SHALL represent a skill as a typed capability `(precondition, procedure, expected_effect, evidence_schema, cost_model, removal_strategy)` and SHALL promote a skill from `candidate` to `validated` only after the capability ledger records ≥N validated successes with evidence refs. A specialist SHALL be bound to a capability set with a measured competence (success_rate, p50/p95 cost) and the swarm SHALL assign specialists to capabilities by competence within the budget. A sub-agent's policy SHALL be the intersection of its parent's policy and the delegated skill's policy. A skill whose success_rate drops below threshold or that is contradicted SHALL be auto-demoted (removal_strategy).

#### Scenario: A skill is auto-promoted, not hand-authored
- **WHEN** the capability ledger records ≥3 validated successes for a candidate skill with evidence
- **THEN** the skill-evaluator promotes it to `validated`
- **AND** the swarm assigns a specialist to it by competence (not a fixed role)

#### Scenario: A sub-agent inherits a scoped policy
- **WHEN** a parent delegates a skill to a sub-agent
- **THEN** the sub-agent's allowed actions = parent ∩ skill, forbidden = parent ∪ skill
- **AND** the depth/budget/concurrency gates enforce the scoped budget + lineage

#### Scenario: A contradicted skill is demoted
- **WHEN** a `contradicts` edge is recorded against a skill's underlying claim
- **THEN** the skill's competence drops and its `removal_strategy` may demote it
- **AND** it is no longer assigned at full trust

### Requirement: Memory is a provenance graph with trust, decay, and contradiction

The system SHALL classify memory into episodic/procedural/semantic/working stores and SHALL bind every memory (DB row and vector point) to `{claim_id, trust, provenance_run, evidence_refs}`. The vector store SHALL be the retrieval index over the graph (claims with provenance), not a bag of free-text. Unvalidated memory SHALL decay on a half-life; a `contradicts` edge SHALL demote the contradicted claim; a `supersedes` edge SHALL replace it. The OKF wiki SHALL be the human-readable projection of the semantic store.

#### Scenario: Retrieved memory carries provenance
- **WHEN** a run retrieves memory via `ContextInjectionService`
- **THEN** each result carries `trust`, `provenance_run`, and `evidence_refs`
- **AND** the receiver can gate on trust

#### Scenario: Contradicted memory is demoted
- **WHEN** a later run records a `contradicts` edge against an existing claim
- **THEN** the contradicted claim's trust is reduced
- **AND** it is not injected at full trust in subsequent runs

### Requirement: The loop is a goal-directed controller with a convergence certificate

The system SHALL plan a goal into a capability DAG, schedule it with bounded concurrency by dependency layer, and adapt on each gate result via a feedback law {retry-higher-competence, split, escalate-human, stop}. The system SHALL certify a run as converged iff `∀ finding: resolved ∧ checker-accepted ∧ evidence-complete ∧ budget-within ∧ isolation-held`. The existing maker/checker/nested DAG SHALL remain the default plan (backward compatible).

#### Scenario: A gate failure triggers adaptation
- **WHEN** a maker gate fails on a finding
- **THEN** the controller retries with a higher-competence specialist OR splits the finding OR escalates OR stops
- **AND** the adaptation is recorded in the manifests/trace

#### Scenario: A non-trivial DAG converges with a certificate
- **WHEN** a goal with a ≥3-capability DAG completes
- **THEN** the run is certified (`production_passed=true` generalised) iff every finding is resolved, checker-accepted, evidence-complete, budget-within, and isolation-held

### Requirement: Scale is a closed-loop resource controller

The system SHALL treat concurrency as a control variable driven by (pending work, remaining budget, observed per-agent cost, system capacity), bounded by `swarm-status.fleetPools().recommended_concurrency`, with hard (kill) and soft (throttle) resource limits. Scale-down SHALL be graceful: in-flight leases are checkpointed and drained (completed or cancelled), not killed mid-artifact without a checkpoint.

#### Scenario: The swarm scales up then down under load
- **WHEN** pending work exceeds capacity and budget allows
- **THEN** concurrency increases (observed lease overlap rises) up to `recommended_concurrency`
- **AND** on budget drain the swarm checkpoints in-flight leases and drains gracefully

### Requirement: Knowledge handoff is verified claim transfer

The system SHALL hand off knowledge as verified claims, not raw text. Within a run, a sub-agent SHALL complete by emitting a claim + evidence_refs that the parent's checker verifies. Across runs, injected memory SHALL carry trust + provenance and the receiver's checker SHALL be able to reject low-trust memory via an `injected_memory_trust` gate.

#### Scenario: A sub-agent hands off a verifiable claim
- **WHEN** a sub-agent lease completes
- **THEN** it emits a claim with evidence_refs to the parent
- **AND** the parent's checker accepts or rejects it on evidence

#### Scenario: Low-trust memory is rejectable
- **WHEN** a run injects memory below the trust threshold
- **THEN** the receiver's `injected_memory_trust` gate can reject it
- **AND** the rejection is recorded in the claim ledger

### Requirement: The envelope is hard (sandbox + anti-poisoning + secret hygiene)

The system SHALL confine every runtime to its worktree via an OS sandbox (landlock/bubblewrap/container or bind-mount + read-only host + no-egress) such that no absolute-path host write is possible. The system SHALL defend against memory poisoning (checker-verifies promoted claims, decay, contradiction, low-trust gating). The system SHALL block secret persistence (CI secret scan + push protection + `MemoryCandidateService.containsSecret`). Merge/push/deploy SHALL require human approval.

#### Scenario: An absolute-path escape is blocked by the OS
- **WHEN** a runtime attempts to write a host path outside its worktree by absolute path
- **THEN** the OS sandbox blocks it (not merely the runtime's own `--sandbox`)
- **AND** the attempt is audited

#### Scenario: A poisoned memory is rejected
- **WHEN** a promoted memory claim has no supporting evidence or is contradicted
- **THEN** the checker rejects it and/or decay/contradiction demotes its trust
- **AND** it is not acted on at full trust

### Requirement: A learned cost model drives budget allocation

The system SHALL learn a per-capability cost distribution (p50/p95 tokens, time, dollars) from runtime-usage history and the planner SHALL allocate the goal budget across the capability DAG as a bounded optimisation (maximise expected verified-artifacts subject to the budget). Efficiency SHALL be measurable as `verified_artifacts / dollar`.

#### Scenario: The planner stays within budget
- **WHEN** a goal runs with a dollar/token budget
- **THEN** the planner's capability selection + concurrency keeps total cost within budget
- **AND** the `verified_artifacts / dollar` efficiency is reported

## MODIFIED Requirements

### Requirement: The proof is a convergence certificate for any goal

`ProofRunService` (the proof) SHALL generalise from the proof-sentinel's artifact-minimums to a **convergence certificate** applicable to any goal: the run is certified iff every finding is resolved, checker-accepted, evidence-complete, budget-within, and isolation-held. `production_passed=true` is the certificate, not a sentinel-specific flag.

#### Scenario: A real goal is certified
- **WHEN** a real (non-sentinel) goal completes
- **THEN** it is certified by the same invariant as the proof sentinel
- **AND** Mission Control shows the certificate + lineage + learning
