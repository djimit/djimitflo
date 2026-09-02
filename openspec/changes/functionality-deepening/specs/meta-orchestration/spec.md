# Meta-orchestration actuator

## Requirements

### Requirement: Evidence-backed tuning

The meta-orchestration service SHALL derive loop tuning from recorded outcomes and SHALL expose the recommendation, confidence, application state, and history through `/api/meta` and the self-driving dashboard.

### Requirement: Bounded automatic application

Recommendations that clear the configured confidence and sample thresholds SHALL be applied to the active goal-type loop parameters. Every application SHALL record the previous value, next value, evidence window, and audit-chain entry. Recommendations below either threshold SHALL remain unapplied.

### Requirement: Reversible state

Applied tuning SHALL remain bounded by configured minimum and maximum values and SHALL retain enough history to restore the previous values without reconstructing them from logs.
