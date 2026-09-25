# Level-8 Complete Specification

## ADDED Requirements

### Requirement: Pre-existing test failures resolved
All 6 test failures introduced before Level-7 SHALL be resolved.

#### Scenario: runtime-security test passes
- **WHEN** the test checks codex runtime command flags
- **THEN** it SHALL verify `--sandbox workspace-write` and `approval_policy=never`

#### Scenario: runtime-semaphore test passes
- **WHEN** multiple semaphore tests run in sequence
- **THEN** `dynamicLimit` SHALL be reset between tests

#### Scenario: g16 daemon test passes
- **WHEN** the daemon processes a goal with no findings
- **THEN** the test SHALL accept `goal_completed` event

#### Scenario: g19 parallel goals test passes
- **WHEN** the daemon processes multiple goals with no findings
- **THEN** the test SHALL accept `goal_completed` + check `started + completed` count

### Requirement: Thompson Sampling bandit converges to optimal runtime
The system SHALL use Thompson Sampling to select runtimes when sufficient data exists.

#### Scenario: Convergence within 20 trials
- **WHEN** 3 runtimes have true success rates of 0.3, 0.5, 0.7
- **THEN** the bandit SHALL select the best runtime >= 80% of the time after 20 trials

#### Scenario: Fallback with insufficient data
- **WHEN** fewer than 5 trials exist per arm
- **THEN** the system SHALL fall back to the existing heuristic

### Requirement: Search feedback improves retrieval quality
The system SHALL track which search results are used and re-rank future results.

#### Scenario: MRR improvement after feedback
- **WHEN** 50 feedback cycles are recorded
- **THEN** mean reciprocal rank SHALL improve >= 10% vs baseline

### Requirement: GOAP A* planner finds optimal paths
The system SHALL plan multi-step goals using A* search through state space.

#### Scenario: Optimal path found
- **WHEN** a solvable goal with 5-10 actions is planned
- **THEN** the planner SHALL find the shortest path in >= 90% of cases

#### Scenario: Replanning on failure
- **WHEN** an action in the plan fails
- **THEN** the system SHALL replan from the current state excluding the failed action

### Requirement: Federation protocol enables secure cross-instance collaboration
The system SHALL support zero-trust federation between instances.

#### Scenario: PII stripping
- **WHEN** a message contains PII (email, SSN, phone, etc.)
- **THEN** the system SHALL strip 14 PII types before transmission

#### Scenario: Trust scoring
- **WHEN** a peer has 80% success rate and 95% uptime
- **THEN** trust score SHALL be >= 0.7

### Requirement: Control loop self-modification is safe
The system SHALL support modifying its own loop contracts with safety gates.

#### Scenario: Proposal requires human approval
- **WHEN** a contract change is proposed
- **THEN** it SHALL NOT be applied without human approval

#### Scenario: Rollback restores previous state
- **WHEN** a contract change causes issues
- **THEN** the system SHALL rollback to the pre-change state

### Requirement: Multi-modal perception processes images
The system SHALL analyze screenshots and diagrams.

#### Scenario: Screenshot analysis
- **WHEN** a dashboard screenshot is provided
- **THEN** the system SHALL extract structured data with >= 80% accuracy

### Requirement: Operator intervention protocol
The system SHALL support human course-correction during autonomous runs.

#### Scenario: Intervention on low confidence
- **WHEN** competence awareness detects a novel situation with low confidence
- **THEN** the system SHALL request operator intervention within 5 seconds

#### Scenario: Approval resumes run
- **WHEN** the operator approves an intervention
- **THEN** the run SHALL resume with elevated privileges
