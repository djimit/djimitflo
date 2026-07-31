# Requirements — Fleet Management Bounded Context

> User Stories with Acceptance Criteria in EARS notation.
> Constitution L1: FR-### in SHALL-format.
> Constitution L6: EC-### in IF-THEN format.

---

## User Story 1 — Agent Registration (Priority: P1)

As an orchestrator, I want to register agents in a fleet so that they can receive tasks.

**Why this priority:** Without agent registration, no tasks can be assigned. This is the MVP.

**Independent Test:** Register an agent via API, verify it appears in fleet status.

**Acceptance Scenarios:**

1. **Given** a fleet "production" exists, **When** agent "worker-1" registers, **Then** the agent appears in the fleet's agent list with status Active
2. **Given** agent "worker-1" already exists in fleet, **When** another register call arrives with the same name, **Then** the system rejects with DuplicateAgentError

---

## User Story 2 — Heartbeat Monitoring (Priority: P1)

As an operator, I want to see agent liveness so that I can detect failures.

**Why this priority:** Without heartbeat monitoring, dead agents keep receiving tasks.

**Independent Test:** Stop an agent's heartbeat, verify it's marked Disconnected after 3 missed intervals.

**Acceptance Scenarios:**

1. **Given** an active agent, **When** it sends a heartbeat, **Then** its lastSeen timestamp updates
2. **Given** an active agent, **When** it misses 3 consecutive heartbeats, **Then** its status changes to Disconnected
3. **Given** a heartbeat transmission fails, **When** the error occurs, **Then** the server catches and logs without crashing (INV-005)

---

## User Story 3 — Lease Management (Priority: P2)

As a task scheduler, I want exclusive leases so that no task is executed twice.

**Why this priority:** Prevents double-execution in distributed scenarios.

**Independent Test:** Grant a lease for task T to agent A, verify agent B cannot get the same lease.

**Acceptance Scenarios:**

1. **Given** task T is available, **When** agent A requests a lease, **Then** the lease is granted with TTL
2. **Given** task T is leased to agent A, **When** agent B requests the same lease, **Then** the system rejects with TaskLockedError
3. **Given** a lease with TTL=60s, **When** 60s passes without renewal, **Then** the lease expires and the task returns to the queue

---

## User Story 4 — Fleet Decommission (Priority: P3)

As an operator, I want to decommission a fleet so that no new agents can join.

**Why this priority:** Operational safety during migrations.

**Acceptance Scenarios:**

1. **Given** an active fleet, **When** Decommission() is called, **Then** Status=Decommissioned
2. **Given** a decommissioned fleet, **When** an agent tries to register, **Then** the system rejects with FleetDecommissionedError

---

## Functional Requirements

- **FR-001:** The system SHALL allow registering agents in a fleet via `RegisterAgent(name)` command
- **FR-002:** The system SHALL reject duplicate agent names within the same fleet with DuplicateAgentError
- **FR-003:** The system SHALL track agent heartbeats and update lastSeen timestamps
- **FR-004:** The system SHALL mark agents as Disconnected after 3 consecutive missed heartbeats
- **FR-005:** The system SHALL grant exclusive leases for tasks with configurable TTL
- **FR-006:** The system SHALL reject lease requests for already-leased tasks with TaskLockedError
- **FR-007:** The system SHALL allow fleet decommissioning, blocking new agent registration
- **FR-008:** Heartbeat transmission failures SHALL NOT crash the server (catch+log)

---

## Edge Cases

- **EC-001:** IF the database is locked (SQLITE_BUSY) during heartbeat processing THEN the system SHALL catch the error and log without crashing
- **EC-002:** IF an agent is removed while holding active leases THEN those leases SHALL be released within 5 seconds
- **EC-003:** IF the server restarts THEN fleet state SHALL be reconstructed from SQLite WAL
- **EC-004:** IF two agents register simultaneously with the same name THEN exactly one SHALL succeed (no race condition)
- **EC-005:** IF a lease TTL expires during task execution THEN the task SHALL be recoverable (not lost)

---

## Traceability

| FR | User Story | Invariant | Test |
|----|-----------|-----------|------|
| FR-001 | US1 | INV-001 | test-register-agent |
| FR-002 | US1 | INV-001 | test-duplicate-agent |
| FR-003 | US2 | INV-003 | test-heartbeat-update |
| FR-004 | US2 | INV-003 | test-agent-disconnect |
| FR-005 | US3 | INV-002 | test-lease-grant |
| FR-006 | US3 | INV-002 | test-lease-conflict |
| FR-007 | US4 | INV-004 | test-decommission |
| FR-008 | US2 | INV-005 | test-heartbeat-failure-isolation |

---

**Version**: 1.0.0 | **BC**: Fleet Management
**Refs**: domain-terms.md, aggregate-fleet.md, bc-fleet-management.md
