## ADDED Requirements

### Requirement: Background worker cleans stale prepared leases
The system MUST automatically cancel prepared leases older than 24 hours.

#### Scenario: Stale prepared lease is cancelled
- **WHEN** a prepared lease has not been updated in >24 hours
- **THEN** the stale-resource-cleanup worker cancels it and records the cancellation reason

#### Scenario: Active prepared lease is preserved
- **WHEN** a prepared lease was updated within the last 24 hours
- **THEN** it is NOT cancelled by the cleanup worker

### Requirement: Background worker marks hung running leases as failed
The system MUST mark running leases as failed after 2 hours of inactivity.

#### Scenario: Hung running lease is marked failed
- **WHEN** a running lease has not been updated in >2 hours
- **THEN** the cleanup worker marks it as failed with reason='stale_timeout'

#### Scenario: Active running lease is preserved
- **WHEN** a running lease was updated within the last 2 hours
- **THEN** it is NOT marked as failed

### Requirement: Cleanup worker thresholds are configurable
The system MUST allow configuration of cleanup thresholds via environment variables.

#### Scenario: Custom thresholds via env vars
- **WHEN** DJIMFLO_STALE_PREPARED_THRESHOLD_HOURS=48 is set
- **THEN** the cleanup worker uses 48 hours instead of the default 24
