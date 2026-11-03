## ADDED Requirements

### Requirement: LoopLifecycleService manages loop lifecycle
The system MUST provide a dedicated service for loop lifecycle operations: start, continue, stop, and recovery.

#### Scenario: Start a new loop
- **WHEN** a user requests to start a new loop
- **THEN** LoopLifecycleService creates the loop run, prepares initial leases, and records the start event

#### Scenario: Continue an existing loop
- **WHEN** a loop run is ready for continuation
- **THEN** LoopLifecycleService prepares maker and checker leases with proper budget allocation

#### Scenario: Stop a running loop
- **WHEN** a user requests to stop a loop
- **THEN** LoopLifecycleService marks all active leases as cancelled and updates loop status

#### Scenario: Recover interrupted loops
- **WHEN** the system restarts with interrupted loops
- **THEN** LoopLifecycleService identifies loops stuck in 'running' state and attempts recovery

### Requirement: LoopService delegates to LoopLifecycleService
The LoopService facade MUST delegate lifecycle methods to LoopLifecycleService without breaking existing callers.

#### Scenario: Existing callers work unchanged
- **WHEN** any existing code calls LoopService.startLoop()
- **THEN** the call is delegated to LoopLifecycleService and produces identical results

#### Scenario: LoopService LOC is reduced
- **WHEN** extraction is complete
- **THEN** LoopService is <1500 LOC and all original tests pass without modification
