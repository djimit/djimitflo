# Level-16 AGI Evolution Specification

## ADDED Requirements

### Requirement: LoopPlanningService handles goal planning concerns

The system SHALL provide a `LoopPlanningService` that encapsulates goal creation, decomposition, runtime selection, and finding discovery. The service SHALL be injected into LoopService as a delegation target.

#### Scenario: Goal creation delegates to LoopPlanningService

- **WHEN** `LoopService.createGoal()` is called
- **THEN** the call SHALL be delegated to `LoopPlanningService.createGoal()`
- **AND** the return value SHALL be identical to the original implementation

#### Scenario: Finding discovery is domain-specific

- **WHEN** `discoverFindings()` is called with a loop name
- **THEN** the service SHALL return findings specific to that loop type
- **AND** unsupported loop types SHALL return an empty array

### Requirement: LoopExecutionService handles maker/worker/checker execution

The system SHALL provide a `LoopExecutionService` that encapsulates all execution concerns including maker/worker/checker lifecycle, worktree management, and nested spawn guards.

#### Scenario: Maker execution produces verifiable output

- **WHEN** `executeMaker()` is called with a valid run ID
- **THEN** the service SHALL produce stdout, stderr, and gate results
- **AND** the worktree SHALL be cleaned up after completion

#### Scenario: Nested spawn respects depth budget

- **WHEN** `prepareNestedLease()` is called at max depth
- **THEN** the service SHALL reject the spawn
- **AND** the response SHALL indicate the depth limit was reached

### Requirement: LoopGovernanceService enforces budgets and gates

The system SHALL provide a `LoopGovernanceService` that enforces token budgets, dollar budgets, wall-clock budgets, and gate verification.

#### Scenario: Token budget enforcement blocks over-budget runs

- **WHEN** a loop run exceeds its token budget
- **THEN** the service SHALL block further execution
- **AND** the run SHALL be marked as budget-exhausted

#### Scenario: Gate verification catches security failures

- **WHEN** `checkGates()` is called on a run with failed security checks
- **THEN** the service SHALL return a fail status
- **AND** the escalation SHALL be triggered

### Requirement: MetacognitiveObserver monitors reasoning quality

The system SHALL provide a `MetacognitiveObserver` that tracks the relationship between predicted confidence and actual outcomes, detects anomalies, and calibrates confidence per domain.

#### Scenario: Overconfidence is detected

- **WHEN** predicted confidence is >0.8 but actual success rate is <0.5 for a domain
- **THEN** the observer SHALL flag an anomaly
- **AND** confidence calibration SHALL be adjusted downward

#### Scenario: Confidence calibration improves over time

- **WHEN** the observer has ≥10 observations for a domain
- **THEN** the calibration error SHALL decrease over time
- **AND** the trend SHALL be tracked as improving/stable/degrading

### Requirement: IntrinsicMotivationModule generates exploration goals

The system SHALL provide an `IntrinsicMotivationModule` that identifies knowledge gaps, scores them by novelty, and generates autonomous exploration goals.

#### Scenario: Knowledge gap triggers exploration

- **WHEN** a domain has fewer than 3 concepts in the knowledge base
- **THEN** the module SHALL generate an exploration goal for that domain
- **AND** the curiosity score SHALL be proportional to the gap size

#### Scenario: Exploration success is tracked

- **WHEN** an exploration goal completes successfully
- **THEN** the module SHALL record the success
- **AND** the curiosity score for related domains SHALL be adjusted

### Requirement: AdversarialInputValidator protects against poisoned inputs

The system SHALL provide an `AdversarialInputValidator` that signs and hashes all external inputs, detects poisoning attempts, and sanitizes display output.

#### Scenario: Input integrity is verified

- **WHEN** an external input is received
- **THEN** the validator SHALL verify its signature and hash
- **AND** invalid inputs SHALL be rejected with a security event logged

#### Scenario: Poisoning attempt is detected

- **WHEN** a batch of inputs shows statistical anomalies
- **THEN** the validator SHALL flag a potential poisoning attempt
- **AND** the affected inputs SHALL be quarantined

### Requirement: FederationTrustManager authenticates peer agents

The system SHALL provide a `FederationTrustManager` that issues scoped capability tokens, verifies them on each request, enforces rate limits, and supports revocation.

#### Scenario: Token is issued with scoped capabilities

- **WHEN** a peer agent is registered
- **THEN** the manager SHALL issue a token with specific scopes
- **AND** the token SHALL have an expiry time

#### Scenario: Revoked token is rejected

- **WHEN** a token is revoked
- **THEN** subsequent requests with that token SHALL be rejected
- **AND** the revocation SHALL be immediate (no cache)

### Requirement: AutonomyRollback enables safe mutation

The system SHALL provide an `AutonomyRollbackService` that snapshots state before mutations, enables rollback to any snapshot, and enforces filesystem-level capability freeze.

#### Scenario: Mutation is rolled back

- **WHEN** a self-modification causes a test failure
- **THEN** the service SHALL restore the pre-modification snapshot
- **AND** the rollback SHALL be logged in the audit trail

#### Scenario: Security code is frozen

- **WHEN** a mutation targets security/audit code
- **THEN** the filesystem freeze SHALL block the write
- **AND** the attempt SHALL be logged as a security event

### Requirement: RSI Engine Dashboard visualizes self-improvement

The system SHALL provide an RSI Engine Dashboard page that displays refactoring proposals, safety status, specialization matrix, and intervention history.

#### Scenario: Refactoring proposals are actionable

- **WHEN** the RSI Engine Dashboard is loaded
- **THEN** pending refactoring proposals SHALL be displayed
- **AND** each proposal SHALL have approve/reject actions

#### Scenario: Safety status is visible

- **WHEN** the dashboard is loaded
- **THEN** the current mutation budget usage SHALL be displayed
- **AND** frozen components SHALL be clearly marked

### Requirement: Expert Swarm Visualizer shows real-time swarm status

The system SHALL provide an Expert Swarm Visualizer page that displays active swarms, knowledge graph, judge verdicts, and source reliability.

#### Scenario: Active swarms are visible

- **WHEN** the swarm visualizer is loaded
- **THEN** all active expert swarm runs SHALL be displayed
- **AND** their status (running/completed/failed) SHALL be updated in real-time

### Requirement: Causal Model Explorer enables counterfactual queries

The system SHALL provide a Causal Model Explorer page that displays intervention history, supports counterfactual queries, and visualizes confidence calibration.

#### Scenario: Counterfactual query returns prediction

- **WHEN** the user submits a "what if" query
- **THEN** the system SHALL return a predicted outcome with confidence
- **AND** the query and response SHALL be logged

## INVARIANTS

- **I1 API stability**: LoopService public API unchanged after decomposition
- **I2 Test preservation**: All existing tests remain green
- **I3 Safety boundary**: Security/audit code immutable by self-modification
- **I4 Audit completeness**: Every RSI action logged with full provenance
- **I5 Bounded mutation**: Max 5 self-modifications per day
- **I6 Graceful degradation**: Service failures don't crash the pipeline
- **I7 Input integrity**: All external inputs validated before processing
- **I8 Federation trust**: Peers authenticated with scoped, revocable tokens
