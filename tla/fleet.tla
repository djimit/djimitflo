---------------------------- MODULE Fleet ----------------------------
(*
 * TLA+ Specification for Fleet Management Aggregate
 *
 * Based on: specs/bounded-contexts/fleet-management/aggregates/aggregate-fleet.md
 * Invariants formalized:
 *   INV-001: No duplicate agent names (RegisterAgent uniqueness)
 *   INV-002: Fleet capacity <= 1000 agents
 *   INV-003: agentCount equals number of non-disconnected agents
 *   INV-004: No new registrations when Decommissioned
 *   INV-005: Heartbeat failure isolation (server doesn't crash)
 *)

EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Agents,             (* Set of all possible agent IDs *)
    MaxCapacity,        (* Maximum agents per fleet = 1000 *)
    AgentNames          (* Set of possible agent names *)

VARIABLES
    agents,             (* [agent_id -> {name, status, lastSeen}] *)
    agent_names,        (* [name -> agent_id] -- reverse index for uniqueness *)
    fleet_status,       (* Active | Draining | Decommissioned *)
    heartbeats          (* sequence of heartbeat records *)

TypeInvariant ==
    /\ agents \in [Agents -> [name: AgentNames, status: {"Active", "Idle", "Disconnected"}, lastSeen: Nat]]
    /\ agent_names \in [AgentNames -> Agents \union {NULL}]
    /\ fleet_status \in {"Active", "Draining", "Decommissioned"}
    /\ heartbeats \in Seq([agent_id: Agents, timestamp: Nat, success: BOOLEAN])

(* INV-001: No duplicate agent names *)
(* Each agent name maps to at most one agent *)
UniqueAgentNames ==
    \A a1, a2 \in Agents :
        a1 # a2 => agents[a1].name # agents[a2].name

(* INV-002: Fleet capacity <= MaxCapacity *)
(* The number of registered agents cannot exceed MaxCapacity *)
CapacityInvariant ==
    Cardinality({a \in Agents: agents[a].name # ""}) <= MaxCapacity

(* INV-003: agentCount equals number of non-disconnected agents *)
(* Count of active + idle agents matches expected count *)
AgentCountConsistent ==
    LET NonDisconnected == {a \in Agents: agents[a].status \in {"Active", "Idle"}}
    IN Cardinality(NonDisconnected) = Cardinality({a \in Agents: agents[a].name # ""})

(* INV-004: No new registrations when Decommissioned *)
(* If fleet is Decommissioned, no new agents can be added *)
NoRegistrationWhenDecommissioned ==
    fleet_status = "Decommissioned" =>
        \A a \in Agents : agents[a].name = ""

(* INV-005: Heartbeat failure isolation *)
(* A failed heartbeat does not crash the server -- it's caught and logged *)
HeartbeatFailureIsolation ==
    \A i \in 1..Len(heartbeats) :
        heartbeats[i].success = FALSE =>
            (* Server state remains valid after failed heartbeat *)
            TypeInvariant'

(* Aggregate safety property: All invariants hold *)
Safety ==
    /\ UniqueAgentNames
    /\ CapacityInvariant
    /\ AgentCountConsistent
    /\ NoRegistrationWhenDecommissioned
    /\ HeartbeatFailureIsolation

(* Liveness: Eventually all heartbeats are processed *)
Liveness ==
    <>[](Len(heartbeats) > 0 => \E i \in 1..Len(heartbeats) : heartbeats[i].success = TRUE)

====
