# AGI Cognitive Evolution Specification

## ADDED Requirements

### Requirement: Self-Model Service calibrates confidence from observed outcomes

The system SHALL provide a `SelfModelService` that tracks per-capability confidence calibration using Platt scaling on historical worker_leases outcomes, detects known unknowns (domains with calibration_error > 0.2 or nRuns < 3), and identifies performance trends (improving/stable/degrading) via linear regression on the last 10 outcomes.

#### Scenario: Calibration after 10 runs with 80% success

- **WHEN** a capability has completed 10 runs with 8 successes and 2 failures
- **THEN** the calibration_error SHALL be less than 0.15
- **AND** the recommendedConfidence SHALL track the observed success rate within ±0.15

#### Scenario: Insufficient data produces conservative confidence

- **WHEN** a capability has fewer than 3 completed runs
- **THEN** the recommendedConfidence SHALL be less than 0.5
- **AND** the capability SHALL appear in the known_unknowns list

#### Scenario: Trend detection identifies degradation

- **WHEN** a capability's last 10 outcomes show a declining success rate (slope < -0.05)
- **THEN** the trend SHALL be reported as 'degrading'

### Requirement: Experience Retrieval Service indexes and retrieves past runs

The system SHALL provide an `ExperienceRetrievalService` that embeds loop run objectives into Qdrant, retrieves the top-5 most similar past runs by vector similarity, and formats them as context blocks for maker/checker prompts.

#### Scenario: Identical objectives retrieve with high similarity

- **WHEN** a new goal has the same objective as a past run
- **THEN** the retrieval SHALL return the past run with similarity > 0.9

#### Scenario: Related objectives retrieve with moderate similarity

- **WHEN** a new goal shares the same capability but different repository context
- **THEN** the retrieval SHALL return past runs with similarity > 0.6

#### Scenario: Graceful degradation when no past runs exist

- **WHEN** no past runs match the query
- **THEN** the retrieval SHALL return an empty array without error

### Requirement: Calibrated Runtime Selection uses confidence-weighted competence

The system SHALL extend `selectRuntime` to use per-runtime competence weighted by the SelfModel's recommended confidence, falling back to the existing heuristic when insufficient data exists (nRuns < 3).

#### Scenario: Best runtime selected with sufficient data

- **WHEN** a capability has ≥5 runs with per-runtime competence data
- **THEN** the runtime with the highest success_rate × recommendedConfidence SHALL be selected

#### Scenario: Fallback when insufficient data

- **WHEN** a capability has fewer than 3 runs
- **THEN** the existing default heuristic SHALL be used

### Requirement: Epistemic Gate Service verifies knowledge-work quality

The system SHALL provide an `EpistemicGateService` that evaluates four epistemic quality gates: source_quality (≥2 sources, not all aged), logical_consistency (no contradicts edges), perspective_coverage (≥2 specialist types or dissent), and falsifiability (testable claims or hypothesis link).

#### Scenario: Source quality gate fails with < 2 sources

- **WHEN** a deliverable has fewer than 2 cited sources
- **THEN** the source_quality gate SHALL return 'fail'

#### Scenario: Logical consistency gate detects contradictions

- **WHEN** a claim used in the deliverable has a contradicts edge in the evidence graph
- **THEN** the logical_consistency gate SHALL return 'fail'

#### Scenario: Falsifiability gate passes with testable claims

- **WHEN** a deliverable contains patterns like "X causes Y" or "Z% improvement"
- **THEN** the falsifiability gate SHALL return 'pass'

### Requirement: Research Loop discovers and investigates knowledge gaps

The system SHALL support a `research-loop` type that discovers research questions from OKF knowledge gaps, unresolved capability_gap claims, and draft hypotheses, then executes them via a DeerFlow-style synthesis executor.

#### Scenario: Discovery from capability gaps

- **WHEN** the system has capability_gap claims older than 30 days
- **THEN** the research loop SHALL generate findings of type 'research_question'

#### Scenario: Discovery from draft hypotheses

- **WHEN** the system has hypotheses in 'draft' state
- **THEN** the research loop SHALL generate findings for each hypothesis

### Requirement: Skill Distillation extracts reusable procedures

The system SHALL provide a `SkillDistillationService` that extracts successful maker trajectories, distills them into reusable procedures via LLM, writes them to the OKF skills directory, and creates capability candidates.

#### Scenario: Distillation after successful maker run

- **WHEN** a maker lease completes successfully
- **THEN** the service SHALL extract the trajectory (prompt + stdout + diff)
- **AND** write a procedure to OKF skills directory
- **AND** create a capability_candidate with source metadata

### Requirement: Curiosity Service scans for information gaps

The system SHALL provide a `CuriosityService` that periodically scans for coverage gaps (domains with <3 claims), confidence gaps (avg confidence < 0.5), contradiction gaps (unresolved contradicted claims), and competence gaps (success_rate < 0.5), then publishes capability_gap claims to the KnowledgeBus.

#### Scenario: Coverage gap detection

- **WHEN** a domain has fewer than 3 claims
- **THEN** the service SHALL publish a capability_gap claim for that domain

#### Scenario: Competence gap detection

- **WHEN** a validated capability has success_rate < 0.5 after ≥3 runs
- **THEN** the service SHALL publish a capability_gap claim for that capability

### Requirement: Goal Formation Service generates autonomous goals

The system SHALL provide a `GoalFormationService` that generates investigation goals from curiosity gaps (max 2 per cycle), detected patterns, and self-model weaknesses (max 1 per cycle), capped at 50% of daemon capacity.

#### Scenario: Autonomous goals from gaps

- **WHEN** information gaps exist and daemon capacity is available
- **THEN** the service SHALL generate ≥1 autonomous goal per cycle

#### Scenario: Capacity cap enforced

- **WHEN** 50% of daemon capacity is already used by autonomous goals
- **THEN** the service SHALL generate 0 new autonomous goals

#### Scenario: Operator goals always preempt

- **WHEN** an operator-submitted goal and an autonomous goal compete for capacity
- **THEN** the operator goal SHALL be scheduled first

### Requirement: Causal Inference Service builds observational models

The system SHALL provide a `CausalInferenceService` that records (runtime, capability_type, goal_type) → outcome observations, supports counterfactual queries ("what if we used X instead of Y?"), and compares runtimes for the same capability.

#### Scenario: Prediction accuracy improves with data

- **WHEN** 20+ observations exist for a given (runtime, capability) combination
- **THEN** counterfactual predictions SHALL achieve >60% accuracy on held-out data

#### Scenario: Sparse data fallback

- **WHEN** fewer than 5 observations exist for a combination
- **THEN** the service SHALL return predictedSuccessRate of 0.5 with confidence < 0.2

### Requirement: Meta-Evolution v2 synthesizes draft contracts

The system SHALL extend `MetaEvolutionService.evaluate()` to synthesize draft loop contracts from recurring capability_gap claims (≥3 occurrences in 30 days), creating draft capabilities with `live_route_allowed: false`.

#### Scenario: Recurring gaps produce draft contracts

- **WHEN** ≥3 capability_gap claims exist for the same domain in 30 days
- **THEN** the service SHALL create a draft loop contract capability

#### Scenario: Draft contracts cannot route live workers

- **WHEN** a draft contract is created
- **THEN** it SHALL have status 'draft' and cannot route live workers without human approval

#### Scenario: No duplication on re-evaluation

- **WHEN** evaluate() is called multiple times for the same recurring gap
- **THEN** only one draft contract SHALL be created
