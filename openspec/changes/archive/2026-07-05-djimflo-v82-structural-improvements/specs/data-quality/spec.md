## ADDED Requirements

### Requirement: Data quality is monitored continuously
The system MUST monitor the completeness of failure metadata and block reasons.

#### Scenario: Failure metadata completeness is tracked
- **WHEN** the data quality monitor runs
- **THEN** it calculates the percentage of failed leases that have complete metadata (verdict, exit_status, failure_reason)
- **AND** alerts if completeness drops below 90%

#### Scenario: Block reason completeness is tracked
- **WHEN** the data quality monitor runs
- **THEN** it calculates the percentage of blocked loops that have structured block reasons
- **AND** alerts if completeness drops below 90%

### Requirement: Data quality score is exposed via API
The system MUST expose a data quality score endpoint.

#### Scenario: Data quality endpoint returns score
- **WHEN** GET /api/intelligence/data-quality is called
- **THEN** it returns: failureMetadataCompleteness, blockReasonCompleteness, staleLeaseCount, overallScore
