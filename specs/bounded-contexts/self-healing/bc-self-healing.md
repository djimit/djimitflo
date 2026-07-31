# Bounded Context: Self-Healing

## Purpose
Automatic detection, diagnosis, and repair of system anomalies. Monitors health, creates incidents, applies healing actions, and learns from patterns.

## Strategic Classification
- **Subdomain Type:** Supporting (operational necessity, not product differentiator)
- **Evolution:** Custom-built (specific to DjimFlo's runtime topology)
- **Business Model:** Cost center (prevents downtime)

## Data Classification

| Data Class | Allowed | Required Assurance |
|------------|---------|-------------------|
| public | no | human-only |
| internal | yes | validated |
| confidential | yes | audited |

## Inbound Communication

| From Context | Channel | Message Type | Pattern |
|--------------|---------|--------------|---------|
| Fleet Management | Event bus | HeartbeatReceived | Customer-Supplier |
| Monitoring | Event bus | MetricSample | Customer-Supplier |

## Outbound Communication

| To Context | Channel | Message Type | Pattern |
|------------|---------|--------------|---------|
| Fleet Management | HTTP API | RestartAgent | Customer-Supplier |
| Monitoring | Event bus | HealthCheckCompleted | Published Language |
| Analytics | Event bus | IncidentResolved | Published Language |

## Ubiquitous Language (Summary)
See `domain-terms.md` for the full glossary.
Key terms: HealthCheck, Incident, HealingAction, Anomaly, CircuitBreaker.

## Business Decisions
- Critical incidents trigger automatic healing attempts
- Failed auto-healing escalates to operator
- Circuit breakers prevent cascade failures
- All healing actions are auditable

## Assumptions
- Healing actions are idempotent (safe to retry)
- Manual override is always available

**Version**: 1.0.0 | **BC**: Self-Healing
