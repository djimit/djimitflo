# DjimFlo Level-5 — Autonomous Federation & Multi-Agent Coordination

## Why (the real gap, not a feature list)

DjimFlo at Level-4 + Level-5 integration (`a761c67c`) is a **verified, integrated,
self-improving, crash-safe, runtime-adaptive, dollar-economical, live-observable,
continuous** agentic OS. All G1-G18 capabilities are implemented AND wired into the
actual execution path. The production proof is green on the workstation.

**It is not yet autonomous or federated.** The gaps are coordination and autonomy,
not architecture:

### A. Coordination gaps (the swarm can't negotiate)

1. **Serial goal processing.** The LoopDaemon processes one goal at a time. A real OS
   processes multiple goals concurrently, bounded by the AIMD controller. The goal queue
   is a serial processor, not a parallel scheduler. **Result**: a long-running goal blocks
   all subsequent goals — the system has throughput 1, not throughput N.

2. **No inter-agent negotiation.** Agents communicate via claims (G5) and the knowledge
   bus (G15), but communication is one-directional: an agent publishes a claim, others
   receive it. There is no protocol for an agent to **request help**: "I need a debugging
   specialist for this finding" → the scheduler responds by spawning one. The swarm is a
   collection of independent workers, not a coordinated team. **Result**: the system can't
   adapt mid-run — if a maker discovers the problem is harder than expected, it can't
   request a different specialist.

3. **No goal decomposition into capability DAGs.** `decomposeGoal` maps to fixed
   LOOP_CONTRACTS (predefined loop shapes). A real OS decomposes arbitrary goals into
   capability DAGs using the planner — "add an API endpoint" becomes
   `analyse→implement→test→document→review`, not "run the doc-drift loop." **Result**: the
   system can only do what the predefined loops do — it can't handle novel goals.

4. **No operator intervention protocol.** The operator can observe (SSE stream) but can't
   intervene: pause a goal, redirect a specialist, inject knowledge, override a decision.
   The system is autonomous but not **steerable**. **Result**: when the swarm goes wrong,
   the only option is to kill it — there's no way to course-correct.

### B. Autonomy gaps (the swarm can't grow)

5. **No autonomous capability acquisition.** The system promotes existing candidate skills
   from evidence (G1 `autoPromoteFromEvidence`) and composes skills (G12
   `createComposedSkill`), but it can't **discover** new capabilities. A specialist that
   encounters a novel problem can't say "I need a new capability for this" and have the
   system create it, assign it, and learn its competence. **Result**: the system's
   capability set is static — it only grows through manual candidate creation.

6. **No resource-aware scheduling.** The AIMD controller couples to `fleetPools()` (G9),
   but the goal scheduler doesn't account for resource availability when assigning goals.
   A goal that needs GPU is scheduled the same as a goal that needs only CPU. **Result**:
   the system doesn't match work to resources — it's priority-scheduled, not
   resource-scheduled.

7. **No prompt injection defense.** The memory-poisoning defense (checker verifies claims,
   trust decay, contradiction) exists from Level-3 (G6), but there's no defense against
   prompt injection through **retrieved context**. A malicious document in the knowledge
   base could manipulate the swarm via the context injection path. **Result**: the system
   is vulnerable to indirect prompt injection — a security gap.

8. **No real federation.** The knowledge bus has HTTP endpoints (G15 scaffold) but no
   federation protocol. A DjimFlo instance can't discover peers, share claims, synchronize
   capabilities, or distribute work across a fleet. **Result**: the system is a single-node
   brain — it can't scale beyond one machine.

## The Level-5 thesis

DjimFlo becomes an **autonomous, federated, coordinated** agentic OS when six things are
true simultaneously:

- **Parallel**: multiple goals execute concurrently, bounded by the AIMD controller. The
  goal queue is a parallel scheduler, not a serial processor. Throughput scales with
  capacity, not capped at 1.
- **Negotiating**: agents can request help mid-run. A maker that discovers a harder problem
  sends a `help_request` on the knowledge bus → the scheduler spawns the needed specialist.
  The swarm is a coordinated team, not independent workers.
- **Decomposing**: arbitrary goals are decomposed into capability DAGs by the planner, not
  mapped to predefined loop contracts. "Add an API endpoint" becomes a multi-step DAG.
- **Steerable**: the operator can intervene — pause, resume, redirect, inject knowledge,
  override decisions — via a structured intervention protocol, not just killing the process.
- **Growing**: the system discovers new capabilities autonomously. A specialist that
  encounters a novel problem creates a candidate capability, the system assigns it, measures
  its competence, and promotes or deprecates it. The capability set grows from experience.
- **Federated**: multiple DjimFlo instances share claims, synchronize capabilities, and
  distribute work across a fleet. The knowledge bus is the federation transport.

Plus: resource-aware scheduling, prompt injection defense, and operator intervention.

## What Changes (the architectural deltas — each is a Goal in `tasks.md`)

- **G19 Parallel goal execution**: the LoopDaemon processes multiple goals concurrently,
  bounded by the AIMD controller. The goal queue is a parallel scheduler.
- **G20 Inter-agent negotiation**: a `help_request` protocol on the knowledge bus. A maker
  can request a specialist mid-run → the scheduler responds by spawning one.
- **G21 Goal decomposition into capability DAGs**: the planner decomposes arbitrary goals
  into multi-step capability DAGs, not predefined loop contracts.
- **G22 Operator intervention protocol**: pause, resume, redirect, inject knowledge,
  override decisions — via a structured API + SSE feedback.
- **G23 Autonomous capability acquisition**: a specialist that encounters a novel problem
  creates a candidate capability → the system assigns it → measures competence → promotes
  or deprecates. The capability set grows from experience.
- **G24 Resource-aware scheduling**: the goal scheduler matches work to resources (CPU,
  GPU, memory) from `fleetPools()`. A GPU-bound goal waits for GPU availability.
- **G25 Prompt injection defense**: sanitize retrieved context before injection. Detect
  injection patterns, strip adversarial instructions, and flag suspicious context.
- **G26 Federation protocol**: peer discovery, claim sharing, capability synchronization,
  and work distribution across multiple DjimFlo instances via the knowledge bus HTTP
  transport.
- **G27 Ship**: a real, multi-goal, parallel, federated production scenario executed by the
  Level-5 swarm: 2+ goals concurrently, inter-agent negotiation, operator intervention,
  autonomous capability acquisition, green, host untouched. OpenSpec closure.

## Non-Goals

- No new runtime (codex/opencode/pi remain the executors).
- No new DB (existing tables extended, not replaced).
- No "AGI" or "consciousness" claims; this is a bounded, verifiable, evidence-gated
  coordination plane.
- No re-architecture of the Level-3/4/5-integration verified baseline.
- No multi-tenant isolation (federation is trust-based, not tenant-isolated).

## Relationship to prior plans

- `djimitflo-level3-completion` (done): the architectural track — typed capabilities,
  memory graph, controller, AIMD, handoff, envelope, economy.
- `djimitflo-level4-production-autonomy` (done): the production track — crash safety,
  runtime adaptation, cognitive memory, dollar economy, observability, continuous operation.
- **This plan** is the **coordination + autonomy track** — parallel execution, negotiation,
  decomposition, operator steering, capability growth, federation. It composes with both:
  Level-3 provides the architecture, Level-4 provides the production baseline, this raises
  the system from "single-node continuous OS" to "autonomous federated multi-agent
  coordinator."
