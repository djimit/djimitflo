## ADDED Requirements

### Requirement: LoopVerificationService manages gate evaluation
The system MUST provide a dedicated service for loop verification, certification, and completion.

#### Scenario: Verify a loop run
- **WHEN** a loop run is ready for verification
- **THEN** LoopVerificationService evaluates all gates and returns pass/fail status

#### Scenario: Certify a loop run
- **WHEN** all gates pass
- **THEN** LoopVerificationService marks the loop as certified and emits a convergence event

#### Scenario: Complete a loop run with human approval
- **WHEN** a user submits human_approval_ref
- **THEN** LoopVerificationService completes the loop and stores the approval reference

#### Scenario: Reject completion without human approval
- **WHEN** a user attempts completion without human_approval_ref for maker work
- **THEN** LoopVerificationService throws LOOP_HUMAN_APPROVAL_REQUIRED

### Requirement: Gate evaluation is deterministic
The SAME loop state MUST always produce the SAME gate evaluation result.

#### Scenario: Idempotent verification
- **WHEN** verifyLoopRun is called twice with the same loop state
- **THEN** both calls return identical gate results
