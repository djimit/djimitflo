# Level-15 Recursive Self-Improvement Engine Specification

## ADDED Requirements

### Requirement: Service Refactoring Analyzer identifies decomposition opportunities

The system SHALL provide a `ServiceRefactoringAnalyzer` that scans source services for size and complexity metrics, identifies services exceeding thresholds (LOC > 1000, methods > 20, dependencies > 15), generates typed refactoring proposals (split, extract_module, simplify), and persists proposals with current state metrics and expected impact.

#### Scenario: Large service triggers split proposal

- **WHEN** a service exceeds 1000 LOC
- **THEN** the analyzer SHALL generate a 'split' proposal
- **AND** the proposal SHALL include estimated LOC reduction of 40%

#### Scenario: High method count triggers extraction proposal

- **WHEN** a service has more than 20 methods
- **THEN** the analyzer SHALL generate an 'extract_module' proposal
- **AND** the proposal SHALL identify cohesive method groups

#### Scenario: High dependency count triggers simplification proposal

- **WHEN** a service has more than 15 import dependencies
- **THEN** the analyzer SHALL generate a 'simplify' proposal
- **AND** the proposal SHALL recommend dependency injection or facade pattern

#### Scenario: Proposal persistence and retrieval

- **WHEN** proposals are generated
- **THEN** they SHALL be persisted in the `refactoring_proposals` table
- **AND** they SHALL be retrievable by status (proposed, approved, applied, rejected)

### Requirement: Causal Inference Service logs interventions and outcomes

The system SHALL extend `CausalInferenceService` with intervention logging that records configuration changes, expected outcomes, and actual outcomes. The service SHALL calculate intervention accuracy and provide historical analysis of all interventions.

#### Scenario: Intervention is logged with expected outcome

- **WHEN** a configuration change is made through the RSI engine
- **THEN** the system SHALL log the intervention with description, changes, and expected outcome
- **AND** the intervention SHALL receive a unique ID for later reference

#### Scenario: Intervention outcome is recorded

- **WHEN** the actual outcome of an intervention becomes known
- **THEN** the system SHALL record the actual outcome and success boolean
- **AND** the intervention record SHALL be updated in place

#### Scenario: Intervention accuracy is calculated

- **WHEN** at least one intervention has a recorded outcome
- **THEN** the system SHALL calculate accuracy as (successful interventions) / (total interventions with outcomes)
- **AND** accuracy SHALL be between 0 and 1

#### Scenario: Intervention history is retrievable

- **WHEN** the intervention history is queried
- **THEN** the system SHALL return interventions ordered by timestamp descending
- **AND** each record SHALL include description, changes, expected outcome, actual outcome, and success status

### Requirement: Emergent Specialization Service tracks agent performance

The system SHALL provide an `EmergentSpecializationService` that records per-(agent, domain, sub-domain) performance, promotes specializations to 'established' after ≥3 runs with ≥80% success, prunes specializations below 20% success over ≥5 runs, and detects cross-domain transfer opportunities.

#### Scenario: Specialization is recorded

- **WHEN** an agent completes a task in a domain
- **THEN** the system SHALL record the performance (success/failure)
- **AND** the success rate SHALL be updated incrementally

#### Scenario: Specialization is promoted to established

- **WHEN** an agent has ≥3 runs in a domain with ≥80% success rate
- **THEN** the specialization SHALL be marked as 'established'
- **AND** the agent SHALL be recommended for future tasks in that domain

#### Scenario: Specialization is pruned

- **WHEN** an agent has ≥5 runs in a domain with <20% success rate
- **THEN** the specialization SHALL be marked as 'pruned'
- **AND** the agent SHALL NOT be recommended for that domain

#### Scenario: Cross-domain transfer is detected

- **WHEN** the same agent has established specializations in multiple domains
- **THEN** the system SHALL detect transfer opportunities
- **AND** transfer confidence SHALL be calculated as shared agents / min(domain size)

### Requirement: Skill Evolution analyzes performance and generates improvements

The system SHALL extend `SkillDistillationService` with post-run analysis that identifies low-confidence skill usage, single-domain coverage gaps, and promotion opportunities. The system SHALL generate typed improvement proposals (clarity, coverage, accuracy, promotion).

#### Scenario: Low confidence triggers clarity improvement

- **WHEN** a skill produces output with confidence < 0.5
- **THEN** the system SHALL generate a 'clarity' improvement proposal
- **AND** the proposal SHALL identify the domain and confidence level

#### Scenario: Single domain coverage is flagged

- **WHEN** a skill is only used in one domain across multiple runs
- **THEN** the system SHALL generate a 'coverage' improvement proposal
- **AND** the proposal SHALL recommend expanding to related domains

#### Scenario: High confidence triggers promotion

- **WHEN** a skill achieves ≥0.8 average confidence over ≥3 runs
- **THEN** the system SHALL generate a 'promotion' proposal
- **AND** the proposal SHALL recommend promoting the skill to validated status

### Requirement: RSI Safety Guard enforces mutation boundaries

The system SHALL provide an `RsiSafetyGuard` that enforces a daily mutation budget (max 5/day), freezes security/audit components from modification, maintains an immutable append-only audit log, provides a kill switch to disable all self-modification, and requires dual-approve for code mutations.

#### Scenario: Mutation within budget is allowed

- **WHEN** the daily mutation count is below 5
- **THEN** the system SHALL allow mutations for non-frozen components
- **AND** the audit log SHALL record the action

#### Scenario: Mutation budget is exhausted

- **WHEN** the daily mutation count reaches 5
- **THEN** the system SHALL block further mutations
- **AND** the response SHALL indicate the budget is exhausted

#### Scenario: Frozen component mutation is blocked

- **WHEN** a mutation targets auth-service, authorization-service, audit-service, rate-limiter, or security-scanning-agent
- **THEN** the system SHALL block the mutation
- **AND** the response SHALL indicate the component is frozen

#### Scenario: Kill switch disables RSI

- **WHEN** the kill switch is disabled
- **THEN** all self-modification capabilities SHALL be blocked
- **AND** the audit log SHALL record the kill switch activation

#### Scenario: Audit log is append-only

- **WHEN** any RSI action occurs
- **THEN** the system SHALL append an entry to the audit log
- **AND** entries SHALL NOT be modifiable or deletable

### Requirement: Expert Swarm Orchestrator uses skills for sub-agent dispatch

The system SHALL extend `ExpertSwarmOrchestrator` to inject skill procedures into sub-agent prompts. Each expert sub-agent SHALL receive its domain-specific skill procedure as context, and the ExpertAnswer SHALL include skill metadata.

#### Scenario: Skill is injected into expert prompt

- **WHEN** an expert sub-agent is dispatched for a domain
- **THEN** the system SHALL retrieve the skill procedure for that domain
- **AND** the skill procedure SHALL be prepended to the research query

#### Scenario: Expert answer includes skill metadata

- **WHEN** an expert sub-agent completes
- **THEN** the ExpertAnswer SHALL include whether a skill was used
- **AND** the answer SHALL include the skill procedure snippet (first 200 chars)

### Requirement: OKF Knowledge Updater creates concepts from verified knowledge

The system SHALL provide an `OkfKnowledgeUpdater` that creates OKF concept files from verified expert swarm results, updates existing concepts with new evidence, links sources to concepts, and maintains an update history.

#### Scenario: Verified knowledge creates OKF concept

- **WHEN** expert swarm produces a verdict with verification_status = 'verified'
- **THEN** the system SHALL create an OKF concept file with frontmatter
- **AND** the concept SHALL include sources, confidence, and domains

#### Scenario: Contradicted knowledge is not stored

- **WHEN** expert swarm produces a verdict with verification_status = 'contradicted'
- **THEN** the system SHALL NOT create an OKF concept
- **AND** the system SHALL log the contradiction

#### Scenario: Existing concept is updated

- **WHEN** a concept already exists for a topic
- **THEN** the system SHALL append new evidence to the existing concept
- **AND** the update SHALL include timestamp and confidence

### Requirement: Worker Pool executes tasks with bounded concurrency

The system SHALL provide a `WorkerPool` that executes N tasks in parallel with configurable concurrency (max 10), retries failed tasks up to 2 times, enforces a 60-second timeout per task, and provides health statistics.

#### Scenario: Tasks execute within concurrency limit

- **WHEN** 10 tasks are submitted with concurrency 3
- **THEN** at most 3 tasks SHALL be active simultaneously
- **AND** all 10 tasks SHALL complete

#### Scenario: Failed task is retried

- **WHEN** a task fails with a transient error
- **THEN** the system SHALL retry the task up to 2 times
- **AND** the result SHALL include the number of attempts

#### Scenario: Timed out task is marked failed

- **WHEN** a task exceeds the 60-second timeout
- **THEN** the task SHALL be marked as failed with TIMEOUT error
- **AND** the slot SHALL be freed for the next task

## MODIFIED Requirements

### Requirement: LoopService refactoring targets (informational)

The existing `LoopService` (5717 LOC) is identified as the primary refactoring target. The system SHALL track refactoring proposals for this service and measure LOC reduction over time. Target: < 4000 LOC through domain extraction.

#### Scenario: Refactoring progress is measurable

- **WHEN** refactoring proposals are applied
- **THEN** the system SHALL measure LOC before and after
- **AND** the refactoring SHALL not reduce test coverage

## REMOVED Requirements

None. This change is purely additive.

## INVARIANTS

- **I1 Bounded modification**: Max 5 self-modifications per day
- **I2 Security boundary**: Auth/audit/security code is immutable by RSI
- **I3 Audit completeness**: Every RSI action is logged with full provenance
- **I4 Rollback capability**: Every modification has a snapshot for rollback
- **I5 Human oversight**: Kill switch and dual-approve for structural changes
- **I6 Test preservation**: Refactoring must not reduce test coverage
- **I7 Graceful degradation**: External API failures do not crash the RSI pipeline
