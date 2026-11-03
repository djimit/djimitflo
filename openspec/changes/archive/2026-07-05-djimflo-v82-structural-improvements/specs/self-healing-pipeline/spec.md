## ADDED Requirements

### Requirement: SelfHealingService runs as background worker
The system MUST run health checks every 15 minutes as part of the background worker pipeline.

#### Scenario: Health checks run automatically
- **WHEN** the background worker pipeline starts
- **THEN** SelfHealingService.checkHealth() runs every 15 minutes
- **AND** results are stored for trend analysis

#### Scenario: Auto-fix is attempted for known issues
- **WHEN** a health check detects a known fixable issue (e.g., stale leases)
- **THEN** the system attempts an automatic fix
- **AND** the fix result is recorded (success/failure)

#### Scenario: Unfixable issues are escalated
- **WHEN** a health check detects an issue that cannot be auto-fixed
- **THEN** a governance_alert event is emitted
- **AND** the issue is logged for human review

### Requirement: Health check results are stored for trending
The system MUST persist health check results over time.

#### Scenario: Health trend is queryable
- **WHEN** an operator queries health history
- **THEN** they see health check results over time with trend indicators
