# Bounded Context: Fleet Management

## Purpose
Manage agent registration, heartbeat monitoring, lease coordination, and peer-to-peer mesh communication for autonomous agent fleets.

## Strategic Classification
- **Subdomain Type:** Core (competitive advantage — fleet orchestration is the product)
- **Evolution:** Custom-built (no off-the-shelf alternative for agent fleet management)
- **Business Model:** Revenue generator (the fleet IS the product)

## Data Classification (ADR-003 Risk-Aware Router)

| Data Class | Allowed | Required Assurance |
|------------|---------|-------------------|
| public | yes | best_effort |
| internal | yes | validated |
| confidential | yes | audited |
| restricted | no | human-only |

## Inbound Communication

| From Context | Channel | Message Type | Pattern | ACL Required |
|--------------|---------|--------------|---------|--------------|
| Orchestration | HTTP API | RegisterAgent | Customer-Supplier | no |
| Orchestration | HTTP API | RequestLease | Customer-Supplier | no |
| Monitoring | HTTP API | GetFleetStatus | Published Language | no |

## Outbound Communication

| To Context | Channel | Message Type | Pattern | Event Contract |
|------------|---------|--------------|---------|----------------|
| Orchestration | Event bus | AgentJoined | Open Host Service | api/events.yaml |
| Orchestration | Event bus | AgentLeft | Open Host Service | api/events.yaml |
| Monitoring | Event bus | HeartbeatReceived | Published Language | api/events.yaml |
| Analytics | Event bus | FleetStatusChanged | Published Language | api/events.yaml |

## Ubiquitous Language (Summary)
See `domain-terms.md` for the full glossary.
Key terms: Fleet, Agent, Heartbeat, Lease, FleetMesh.

## Business Decisions
- A Fleet can be Confirmed only once. Re-confirmation is rejected.
- An empty Fleet (no agents) cannot be Confirmed.
- Heartbeat failures MUST NOT crash the server (R35 fix — catch and log).
- Leases are exclusive — no double-execution tolerated.
- FleetMesh operates independently of server availability.

## Assumptions
- Agent identity is verified at registration (no auth logic in heartbeat path).
- Heartbeat interval is configurable per fleet (default 30s).
- Lease TTL is configurable per task type.
- SQLite is the persistence layer (no external DB for fleet state).

## Compliance Verification
- [x] Every inbound/outbound relationship has a corresponding entry in context-map.md
- [x] Pattern choice is justified per relationship
- [x] Data classification aligns with OpenMythos model registry
- [x] "Business Decisions" formalized as invariants in aggregate-fleet.md

**Version**: 1.0.0 | **BC**: Fleet Management | **Refs**: ../context-map.md, domain-terms.md
