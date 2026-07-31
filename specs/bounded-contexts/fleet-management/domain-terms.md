# Domain Terms — Fleet Management Bounded Context

> Ubiquitous Language for the Fleet Management BC.
> Every term below has exactly one meaning within this BC.
> Cross-BC terms are mapped in `../context-map.md`.
>
> **Spec First L1**: First artifact created — before database schema, before API contract.
> **Constitution**: Article VI.1 — Aliases to AVOID are forbidden identifiers.

---

## Traceability Matrix

| Term | Definition | FR refs | Aggregate refs | Event refs | Status |
|------|-----------|---------|----------------|------------|--------|
| Fleet | Collection of agents managed as a unit | FR-001 | aggregate-fleet | FleetRegistered | draft |
| Agent | Single autonomous worker registered in the fleet | FR-001, FR-002 | aggregate-fleet | AgentJoined, AgentLeft | draft |
| Heartbeat | Periodic liveness signal from agent to server | FR-003 | aggregate-fleet | HeartbeatReceived | draft |
| Lease | Exclusive lock on a task for a specific agent | FR-004 | aggregate-lease | LeaseGranted, LeaseExpired | draft |
| FleetMesh | Peer-to-peer communication layer between agents | FR-005 | aggregate-fleet | MeshConnected | draft |

---

## Term: Fleet

**Definition:**
A named collection of agents that are managed, monitored, and orchestrated as a single operational unit.

**Business Context:**
Created when the first agent registers under a new fleet name. Agents join and leave dynamically.

**Invariants (EARS):**
- WHEN a Fleet is created THEN the system SHALL generate a unique fleetId
- THE Fleet's agent count SHALL equal the number of active leases for that fleet

**Related Terms:**
Agent, Lease, FleetMesh

**Aliases to AVOID:**
AgentGroup, AgentPool, Cluster, Swarm, Deployment, FleetInstance

**Cross-BC Mapping:**
- In Orchestration BC: Fleet = WorkerPool

---

## Term: Agent

**Definition:**
A single autonomous worker process registered in the fleet that executes tasks and emits heartbeats.

**Business Context:**
An agent registers with a unique name and joins exactly one fleet. States: Registering -> Active -> Idle -> Disconnected.

**Invariants (EARS):**
- WHEN an Agent joins a Fleet IF the agent name already exists THEN reject with DuplicateAgentError
- THE Agent SHALL emit a heartbeat within the configured interval (default 30s)
- WHEN an Agent misses 3 consecutive heartbeats THEN mark it Disconnected

**Related Terms:**
Fleet, Heartbeat, Lease

**Aliases to AVOID:**
Worker, Node, Bot, Runner, Instance, Process, Service

---

## Term: Heartbeat

**Definition:**
A periodic liveness signal sent from an agent to the fleet server.

**Business Context:**
Agents emit heartbeats at configurable intervals. The server tracks last-seen timestamps.

**Invariants (EARS):**
- THE Heartbeat SHALL include: agentId, timestamp, status, activeTaskCount
- WHEN the server receives a Heartbeat THEN update the agent's lastSeen timestamp
- IF a Heartbeat fails to transmit THEN catch and log locally without crashing the server

**Related Terms:**
Agent, Fleet

**Aliases to AVOID:**
Ping, HealthCheck, AliveSignal, Keepalive, StatusUpdate, Tick

---

## Term: Lease

**Definition:**
An exclusive lock granting a specific agent the right to execute a specific task for a bounded duration.

**Business Context:**
Leases prevent double-execution of tasks. If the agent fails, the lease expires and the task becomes available again.

**Invariants (EARS):**
- WHEN a Lease is granted IF another active Lease exists for the same task THEN reject with TaskLockedError
- THE Lease SHALL have a maximum duration (TTL) after which it auto-expires
- WHEN a Lease expires THEN the associated task SHALL return to the available queue

**Related Terms:**
Agent, Fleet

**Aliases to AVOID:**
Lock, Mutex, Claim, Reservation, Token, Semaphore, TaskAssignment

---

## Term: FleetMesh

**Definition:**
The peer-to-peer communication layer that allows agents within a fleet to exchange state without routing through the central server.

**Business Context:**
FleetMesh enables agent-to-agent communication for load balancing and state sharing.

**Invariants (EARS):**
- THE FleetMesh SHALL NOT be a single point of failure for task execution
- WHEN the server is unreachable THEN the FleetMesh SHALL continue to function

**Related Terms:**
Fleet, Agent

**Aliases to AVOID:**
Mesh, Network, Overlay, PeerNetwork, GossipLayer, AgentBus

---

**Version**: 1.0.0 | **BC**: Fleet Management | **Refs**: ../context-map.md
