# Design — DjimFlo Level-5 Autonomous Federation

## 1. The coordination framing (the spine)

Level-4 modelled the swarm as a production OS (continuous, crash-safe, observable).
Level-5 models it as a **coordinated team**: multiple goals execute in parallel, agents
negotiate for help, the operator steers mid-run, and the system grows its own capabilities.

The key shift: from **serial autonomy** to **parallel coordination**. The system is no
longer a single-threaded daemon — it's a concurrent scheduler that manages multiple
in-flight goals, each with its own swarm, all bounded by the AIMD controller.

```
┌──────────────────────────────────────────────────────────────────┐
│                   DjimFlo Level-5 Coordinator                      │
│                                                                    │
│  ┌──────────┐   ┌───────────────┐   ┌─────────────────────────┐   │
│  │ Goal     │──▶│ Parallel      │──▶│ Goal Decomposer (G21)   │   │
│  │ Queue    │   │ Scheduler     │   │ goal → capability DAG   │   │
│  │ (sorted) │   │ (AIMD-bounded)│   │ (not predefined loops)  │   │
│  └──────────┘   └───────┬───────┘   └───────────┬─────────────┘   │
│                         │                       │                  │
│         ┌───────────────┼───────────────────────┘                  │
│         │  ┌────────────▼──────────────────────────┐              │
│         │  │ Swarm A (goal 1)  Swarm B (goal 2)     │              │
│         │  │  maker ←→ checker   maker ←→ checker   │              │
│         │  │      ↕                ↕                │              │
│         │  │  help_request      help_request        │              │
│         │  │  (G20 negotiation bus)                 │              │
│         │  └───────────────────────────────────────┘              │
│         │                                                           │
│  ┌──────▼──────────┐   ┌──────────────┐   ┌──────────────────┐    │
│  │ Resource-Aware   │   │ Operator     │   │ Autonomous       │    │
│  │ Scheduler (G24)  │   │ Intervention │   │ Capability       │    │
│  │ CPU/GPU/mem match│   │ (G22)        │   │ Acquisition (G23)│    │
│  └─────────────────┘   └──────────────┘   └──────────────────┘    │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │ Federation Protocol (G26)                                 │     │
│  │ peer discovery · claim sharing · capability sync · work   │     │
│  │ distribution across multiple DjimFlo instances            │     │
│  └──────────────────────────────────────────────────────────┘     │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │ Prompt Injection Defense (G25)                            │     │
│  │ sanitize retrieved context · detect injection patterns    │     │
│  └──────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
```

## 2. Parallel goal execution (G19)

The LoopDaemon evolves from serial to parallel:

```
ParallelLoopDaemon:
  loop:
    goals = loadQueue()  // sorted by (risk, value, cost)
    availableSlots = AIMD.dynamicLimit - activeGoals.count
    for goal in goals.take(availableSlots):
      executeGoalAsync(goal)  // non-blocking — starts a swarm and continues
    sleep(pollMs)
```

Each goal gets its own swarm (maker/checker/nested) running concurrently. The AIMD
controller bounds the total number of concurrent runtime leases across ALL goals —
not per-goal. This means the controller is the global concurrency gate.

**Isolation**: each goal's swarm runs in its own worktree (already enforced). Goals
don't share worktrees. The DB is shared (better-sqlite3 serializes writes), but each
goal has its own `loop_run` with its own findings, leases, and checkpoints.

## 3. Inter-agent negotiation (G20)

A new message type on the knowledge bus: `help_request`.

```
HelpRequest := {
  type: 'help_request',
  from_lease_id: string,
  from_run_id: string,
  capability_needed: string,  // e.g., 'debugging', 'testing'
  reason: string,
  urgency: 'low' | 'medium' | 'high',
}

HelpResponse := {
  type: 'help_response',
  to_lease_id: string,
  spawned_lease_id: string,
  runtime: string,
  status: 'accepted' | 'rejected',
}
```

The negotiation flow:
1. A maker encounters a harder-than-expected problem → emits a `help_request` on the
   knowledge bus.
2. The `NegotiationCoordinator` (a new service) receives the request.
3. The coordinator checks: is there a specialist with the needed capability + available
   capacity (AIMD)?
4. If yes: spawn a nested specialist (via `NestedSpawnService`) → emit `help_response`.
5. If no: emit `help_response` with `status: 'rejected'` (the maker proceeds alone).

This makes the swarm a **coordinated team** — agents can ask for help and the system
responds by spawning the needed specialist.

## 4. Goal decomposition into capability DAGs (G21)

The planner evolves from "pick a predefined loop contract" to "decompose the goal into a
capability DAG":

```
decomposeGoalToDAG(goal): CapabilityDAG {
  // 1. Parse the goal's objective into steps (using the runtime, headless, sandboxed).
  //    e.g., "add an API endpoint" → [analyse, implement, test, document, review]
  // 2. For each step, find a matching capability (from swarm_capabilities).
  // 3. Build a DAG with dependencies (implement depends on analyse, test depends on
  //    implement, etc.).
  // 4. Return the DAG — the scheduler executes it layer by layer.
}
```

The decomposition uses the runtime (codex, headless) to parse the objective — this is a
real LLM call, not a keyword match. The result is a DAG of capability invocations, not a
predefined loop contract.

**Backward compatibility**: if the decomposition fails (no runtime, parse error), the
system falls back to the existing `decomposeGoal` (predefined loop contracts).

## 5. Operator intervention protocol (G22)

New API endpoints for operator intervention:

```
POST /api/goals/:id/pause     — pause the goal (stop accepting new findings, drain)
POST /api/goals/:id/resume    — resume the paused goal
POST /api/goals/:id/redirect  — redirect a specialist (change the runtime or capability)
POST /api/goals/:id/inject    — inject knowledge (add a claim to the semantic store)
POST /api/goals/:id/override  — override a gate decision (force proceed/stop)
```

Each intervention emits an event on the SSE stream (G14) so the operator sees the effect
in real-time. Interventions are logged in the audit trail.

## 6. Autonomous capability acquisition (G23)

When a specialist encounters a novel problem (no matching capability in the DB):

```
acquireCapability(context):
  1. The specialist emits a 'capability_gap' claim on the knowledge bus.
  2. The CapabilityAcquisitionService receives it.
  3. It creates a candidate capability:
     - id: auto-generated
     - kind: 'skill'
     - allowed_actions: ['spawn_runtime_worker']
     - status: 'candidate'
  4. The next run that needs this capability can use it (at candidate trust level).
  5. After ≥3 validated successes, it's auto-promoted (G1 autoPromoteFromEvidence).
  6. After ≥3 failures, it's auto-deprecated (G1 auto-deprecation).
```

This makes the capability set **grow from experience** — the system discovers what it
needs and learns whether it works.

## 7. Resource-aware scheduling (G24)

The goal scheduler matches work to resources:

```
scheduleGoal(goal, resources):
  const requiredResources = estimateResources(goal)  // CPU, GPU, memory
  const available = fleetPools().filter(p => p.hasResources(requiredResources))
  if available.length > 0:
    assignToPool(available[0])
  else:
    queue.defer(goal, reason: 'waiting_for_resources')
```

The `estimateResources` function uses the goal's metadata (e.g., `requires_gpu: true`)
and the capability's learned cost model (CPU/mem from historical runs). A GPU-bound goal
waits for GPU availability, rather than being scheduled on a CPU-only node.

## 8. Prompt injection defense (G25)

The `ContextInjectionService` sanitizes retrieved context before injection:

```
sanitizeContext(context: string): string {
  // 1. Detect injection patterns: "ignore previous instructions", "you are now...",
  //    "system:", "execute:", etc.
  // 2. Strip adversarial instructions (keep the factual content, remove commands).
  // 3. Flag suspicious context (add a [SANITIZED] tag).
  // 4. Log the sanitization event for audit.
}
```

This is a defense-in-depth layer: even if a malicious document enters the knowledge base,
the context injection path strips adversarial instructions before they reach the runtime.

## 9. Federation protocol (G26)

The federation protocol extends the knowledge bus HTTP transport:

```
FederationProtocol:
  1. Peer discovery: GET /api/federation/peers → list of known DjimFlo instances.
  2. Peer registration: POST /api/federation/register → add a peer.
  3. Claim sharing: POST /api/knowledge/publish → publish a claim to the bus (already
     exists from G15).
  4. Capability sync: GET /api/federation/capabilities → list capabilities; a peer can
     subscribe to capability transitions (promote/deprecate) via SSE.
  5. Work distribution: POST /api/federation/work → offer work to a peer; the peer
     accepts or rejects based on available capacity.
```

This is a trust-based federation — no authentication between peers beyond the existing
JWT auth. A peer joins by registering, then subscribes to the knowledge bus and
capability sync. Work distribution is voluntary (a peer can reject work).

## 10. Invariants (extended from Level-4)

- **I1-I13**: (unchanged from Level-4)
- **I14 Parallel-safe**: concurrent goals don't corrupt shared state (DB-serialized,
  worktree-isolated).
- **I15 Negotiable**: agents can request and receive help mid-run.
- **I16 Decomposable**: arbitrary goals are decomposed into capability DAGs.
- **I17 Steerable**: the operator can intervene without killing the process.
- **I18 Growing**: the capability set grows from experience (autonomous acquisition).
- **I19 Resource-matched**: work is matched to available resources.
- **I20 Injection-safe**: retrieved context is sanitized before injection.
- **I21 Federated**: multiple instances share claims, capabilities, and work.

## 11. Risks

- **R1 Parallel complexity**: concurrent goals with shared DB + AIMD controller is more
  moving parts. Mitigation: better-sqlite3 serializes writes; AIMD is the global gate;
  each goal is worktree-isolated.
- **R2 Negotiation deadlock**: two agents both request help from each other → deadlock.
  Mitigation: the coordinator rejects help_requests that would create a cycle (the
  NestedSpawnService already has a cycle guard).
- **R3 Decomposition quality**: an LLM-decomposed DAG could be wrong (missing steps,
  wrong dependencies). Mitigation: the checker verifies each step; the feedback law (G3)
  retries with a different decomposition on failure.
- **R4 Federation trust**: a malicious peer could inject bad claims. Mitigation: trust
  decay (G2) + contradiction (G2) + checker verification (G6) + the federation is
  opt-in (the operator must register peers).
- **R5 Injection defense over-fits**: sanitization could strip legitimate context.
  Mitigation: the sanitization is conservative (only strips known injection patterns,
  not all instructions); flagged context is logged for review.
