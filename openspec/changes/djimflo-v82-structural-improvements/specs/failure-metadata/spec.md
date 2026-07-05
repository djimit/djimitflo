## ADDED Requirements

### Requirement: All maker failures record structured metadata
The system MUST record failure metadata in the worker_leases table BEFORE throwing any exception from executeMaker.

#### Scenario: Worktree not found records failure before throwing
- **WHEN** executeMaker encounters a missing worktree path
- **THEN** the lease metadata is updated with verdict='insufficient_evidence', exit_status='MAKER_WORKTREE_NOT_FOUND', and failure_reason
- **AND** the exception is then thrown with full context available in the database

#### Scenario: Manual runtime requires human records failure before throwing
- **WHEN** executeMaker is called with runtime='manual'
- **THEN** the lease metadata is updated with exit_status='MANUAL_MAKER_REQUIRES_HUMAN'
- **AND** the exception is then thrown

#### Scenario: Recording failure never masks original error
- **WHEN** recordMakerFailure encounters a database error
- **THEN** the error is caught and logged, and the original exception is still thrown
- **AND** the system does not crash due to metadata recording failure

### Requirement: Blocked loops include structured block reasons
The system MUST record structured block reasons in loop_runs.metadata when gates fail.

#### Scenario: Gate failure records block reason
- **WHEN** verifyLoopRun detects failing gates
- **THEN** the loop metadata includes: failed gate names, evidence for each failure, recommended next actions, and timestamp

#### Scenario: Block reason is queryable
- **WHEN** an operator queries a blocked loop
- **THEN** they can see exactly which gates failed and why, enabling debugging without log analysis
