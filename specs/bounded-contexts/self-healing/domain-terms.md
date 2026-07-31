# Domain Terms — Self-Healing Bounded Context

> Ubiquitous Language for the Self-Healing BC.
> Every term below has exactly one meaning within this BC.

---

## Term: HealthCheck

**Definition:**
A diagnostic probe that evaluates a specific subsystem and returns a status of healthy, degraded, or critical.

**Business Context:**
Health checks run on schedule or on-demand. Each check has a name, status, message, and timestamp. Failed checks trigger incident creation.

**Invariants (EARS):**
- THE HealthCheck SHALL have status: healthy, degraded, or critical
- WHEN a HealthCheck runs THEN lastChecked SHALL be updated
- IF status is 'critical' THEN an Incident SHALL be created

**Related Terms:**
Incident, HealingAction

**Aliases to AVOID:**
Check, Probe, Test, Monitor, Ping, StatusCheck

---

## Term: Incident

**Definition:**
A recorded system anomaly that requires attention, either automated healing or manual intervention.

**Business Context:**
Incidents are created from critical health checks or detected anomalies. They track: type, severity, auto-fix attempts, and resolution state.

**Invariants (EARS):**
- THE Incident SHALL have severity: low, medium, high, or critical
- WHEN an Incident is created THEN autoFixAttempted SHALL be false
- IF autoFixSucceeded is false AND severity is critical THEN escalate to operator

**Related Terms:**
HealthCheck, HealingAction

**Aliases to AVOID:**
Issue, Problem, Error, Failure, Alert, Ticket

---

## Term: HealingAction

**Definition:**
An automated remediation step applied to resolve an incident, with recorded result and output.

**Business Context:**
Healing actions are attempted automatically for eligible incidents. Each action records: what was done, whether it succeeded, and output for audit.

**Invariants (EARS):**
- THE HealingAction SHALL reference exactly one Incident
- WHEN attempted THEN result SHALL be: success, failed, or skipped
- IF result is failed THEN the Incident SHALL remain open

**Related Terms:**
Incident

**Aliases to AVOID:**
Fix, Repair, Remediation, Action, Step, Operation

---

## Term: Anomaly

**Definition:**
A detected deviation from expected system behavior that may indicate an underlying issue.

**Business Context:**
Anomalies are detected via statistical analysis of metrics (failed loop rate, stale leases, DB bloat). They trigger health check escalation.

**Invariants (EARS):**
- THE Anomaly SHALL have a detection timestamp
- WHEN detected THEN a HealthCheck SHALL be triggered
- IF anomaly persists for > 5 minutes THEN create Incident

**Related Terms:**
HealthCheck, Incident

**Aliases to AVOID:**
Deviation, Outlier, Spike, Irregularity, Aberration

---

## Term: CircuitBreaker

**Definition:**
A governance pattern that temporarily disables a failing subsystem to prevent cascade failures, with automatic recovery attempts.

**Business Context:**
Circuit breakers protect the system from repeated failures. States: closed (normal), open (failing, reject requests), half-open (testing recovery).

**Invariants (EARS):**
- THE CircuitBreaker SHALL have state: closed, open, or half-open
- WHEN failure threshold exceeded THEN state SHALL transition to open
- IF state is open for > cooldown period THEN transition to half-open

**Related Terms:**
Incident, HealingAction

**Aliases to AVOID:**
Breaker, Failsafe, Guard, Protector, SafetySwitch

---

**Version**: 1.0.0 | **BC**: Self-Healing
