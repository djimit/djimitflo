# DjimFlo Level-4 — Production Autonomy & Self-Improvement

## Why (the real gap, not a feature list)

DjimFlo at Level-3 (`b8c66f8e`) is a **verified, typed, closed-loop, graph-backed agentic
runtime**: capabilities are typed + competence-measured, memory carries provenance + trust
+ decay + contradiction, the loop is a goal-directed controller (planner → scheduler →
feedback law → convergence certificate), scale is AIMD-driven, knowledge handoff is
verified-claim-based, the envelope is OS-sandboxed (bwrap), and the economy tracks
per-capability cost distributions. The G7 ship demo verified `production_passed=true` on a
real code task with the host untouched.

**It is not yet a production system.** The gaps are operational and cognitive, not
architectural:

### A. Level-3 remainder (5 deferred sub-tasks + 1 security debt)

1. **Memory stores are unlabeled (T2.1, T2.5).** The four stores exist functionally —
   episodic (run logs), procedural (skills + OKF), semantic (claims), working (loop state)
   — but the flywheel writes everything as `operational_memory` with no store routing. The
   vector store is the de facto retrieval index over the graph, but this is undocumented
   and the retrieval path doesn't filter by store. **Result**: retrieval returns a bag of
   mixed-context memories, not typed knowledge the receiver can reason about.

2. **Resource envelope is incomplete (T4.1).** AIMD drives `dynamicLimit` but the hard cap
   is a static env var (`RUNTIME_MAX_CONCURRENCY=4`), not coupled to
   `fleetPools().recommended_concurrency` (deferred at loop-service:437 to avoid a circular
   import). Dollars, CPU, mem, GPU are not in the budget. **Result**: the controller can't
   see system capacity — it scales blindly, not by available resources.

3. **Scale-down is abrupt (T4.3).** AIMD cuts `dynamicLimit × 0.5` on failure but doesn't
   checkpoint-and-drain in-flight leases. `loop_checkpoints` exist (before/after per lease)
   but aren't used for resume. `recoverInterruptedRuns()` marks runs as `interrupted`, it
   doesn't resume them. **Result**: a budget-exhaustion or crash mid-artifact loses all
   in-flight work — the system is not crash-safe.

4. **Cross-fleet knowledge bus deferred (T5.3).** Claims are in-process only (SQLite +
   Qdrant on one machine). No pub/sub, no federation. **Result**: the system can't share
   learned knowledge across instances or fleets — it's a single-node brain.

5. **Secret debt.** The user's workstation commits (`1b914de6`, `98fec69b`) hardcode the
   Qdrant API key in `index_djimitkb.py` + `index_djimitkb_incremental.py`. GitHub push
   protection blocks these. The key must be rotated + the history purged before the
   workstation line can merge to origin.

### B. Level-4 production gaps (what makes it an OS, not a lab demo)

6. **No crash recovery with resume.** `recoverInterruptedRuns()` marks orphaned runs as
   `interrupted` — it doesn't restore from the last checkpoint and resume. A production OS
   must survive restarts: detect interrupted runs, restore lease state from
   `loop_checkpoints`, re-queue pending findings, and resume or bounded-fail. **Result**:
   every restart is a cold start — all in-flight work is lost.

7. **Runtime selection is static.** The type system supports codex/opencode/pi/claude/gemini
   but `planLoopRun` picks the runtime from `run.metadata.runtime` (a fixed field set at
   goal creation). The planner doesn't select the runtime by `(capability, competence,
   cost, sovereignty requirement)`. **Result**: the fleet can't adapt — a sovereign
   (offline) task can't automatically route to Pi, a lightweight task can't route to
   opencode, a complex task can't route to codex.

8. **Memory is run-summaries, not distilled rules.** The memory_curator writes
   run-summaries to Qdrant. A true learning system distills actionable rules: "when fixing
   TypeScript type errors in loop-service, check for missing null guards on metadata
   objects" — not "run X completed with 4 leases and 3 claims." **Result**: retrieval
   returns narrative, not actionable knowledge the next specialist can apply.

9. **Skills are atomic, not composable.** A skill is a single capability
   `(precondition, procedure, expected_effect, ...)`. Real work needs skill chains:
   "diagnose → fix → test → verify" as a composed procedure with inter-skill handoff. The
   capability DAG (G3) is per-goal, not reusable. **Result**: the system re-plans every
   goal from scratch — it doesn't accumulate reusable procedures.

10. **Observability is polling, not streaming.** Mission Control is a REST endpoint
    (`/api/swarms/intelligence/mission-control`). The observability routes are admin-only
    REST. No websocket/SSE for live swarm execution. No real-time view of the AIMD
    controller adjusting, trust scores changing, capabilities promoting. **Result**: the
    operator can't watch the system think — they poll snapshots.

11. **Economy is token-only.** The cost model tracks `p50_tokens`/`p95_tokens`. No dollar
    denomination, no cost-per-verified-artifact, no budget allocation across the DAG. The
    planner scores by `success_rate / p50_cost` (token cost) but doesn't optimise for
    `verified_artifacts / dollar`. **Result**: the system is efficient in tokens but blind
    to real cost — it can't answer "is this goal worth $5?"

12. **No continuous operation mode.** The system runs one-shot proofs. A production OS
    runs continuously: accepts goals from a queue, executes them in priority order, learns
    from each, and improves. There's no goal queue, no scheduler loop, no "always-on" mode.
    **Result**: the system is a batch processor, not an operating system.

## The Level-4 thesis

DjimFlo becomes a **production agentic OS** when six things are true simultaneously:

- **Crash-safe**: every run can be resumed from its last checkpoint after a restart. The
  system detects interrupted runs, restores lease state, re-queues pending findings, and
  resumes or bounded-fails. No in-flight work is lost to a restart.
- **Runtime-adaptive**: the planner selects the runtime per finding by
  `(capability, competence, cost, sovereignty)`. Sovereign tasks route to Pi, lightweight
  tasks to opencode, complex tasks to codex — automatically, not by hand.
- **Cognitive**: memory is distilled into actionable rules, not run-summaries. Skills are
  composable into reusable procedures. The system accumulates knowledge it can apply, not
  narratives it can read.
- **Economically rational**: the cost model is dollar-denominated. The planner allocates
  the goal budget across the DAG as a bounded knapsack. The efficiency metric is
  `verified_artifacts / dollar`. The system can refuse a goal that's not worth the cost.
- **Live-observable**: the operator can watch the swarm execute in real-time — AIMD
  adjustments, trust score changes, capability promotions, lease state transitions — via
  streaming (SSE/WebSocket), not polling.
- **Continuous**: the system runs an always-on goal queue. Goals arrive, are prioritised by
  (risk, value, cost), decomposed into capability DAGs, executed by the swarm, certified,
  and learned from. The system improves with every run.

Plus the Level-3 remainder: 4-store memory formalization, resource envelope coupling,
graceful scale-down, cross-fleet knowledge bus foundation, and secret rotation.

## What Changes (the architectural deltas — each is a Goal in `tasks.md`)

- **G8 Memory store formalization**: classify memory into episodic/procedural/semantic/
  working; route the flywheel write by store; retrieval filters by store; vector store =
  retrieval index over the graph (T2.1 + T2.5).
- **G9 Resource envelope + graceful scale-down**: couple `fleetPools().recommended_concurrency`
  to the AIMD hard cap; add dollars/CPU/mem to the budget; checkpoint-and-drain on budget
  exhaustion (T4.1 + T4.3).
- **G10 Crash recovery with resume**: detect interrupted runs, restore from
  `loop_checkpoints`, re-queue pending findings, resume or bounded-fail. The system
  survives restarts.
- **G11 Runtime-adaptive selection**: the planner selects the runtime per finding by
  `(capability, competence, cost, sovereignty)`. Sovereign → Pi, lightweight → opencode,
  complex → codex.
- **G12 Memory distillation + skill composition**: the memory_curator distills actionable
  rules from run evidence; skills compose into reusable procedures (skill chains with
  inter-skill handoff).
- **G13 Dollar economy + budget allocation**: dollar-denominated cost model;
  `verified_artifacts / dollar` metric; planner allocates goal budget across the DAG
  (bounded knapsack).
- **G14 Live observability**: SSE/WebSocket streaming of swarm execution — AIMD state,
  trust scores, capability transitions, lease lifecycle. Mission Control becomes real-time.
- **G15 Cross-fleet knowledge bus foundation**: in-process pub/sub on typed claims (the
  `swarm_learning` table + claim ledger); HTTP transport scaffold for federation.
- **G16 Continuous operation mode**: always-on goal queue with priority scheduling;
  goals arrive, decompose, execute, certify, learn. The system runs as a daemon.
- **G17 Secret rotation + history purge**: rotate the Qdrant API key; `git filter-repo`
  the workstation history; reconcile the workstation line with origin.
- **G18 Ship**: a real, multi-step production goal (e.g., "add a new API endpoint + tests +
  docs + migration") executed by the Level-4 swarm: runtime-adaptive, crash-safe,
  economically rational, live-observable, with distilled memory + composed skills, green,
  host untouched. OpenSpec closure.

## Non-Goals

- No new runtime (codex/opencode/pi remain the executors).
- No new DB (existing tables extended, not replaced).
- No multi-tenant fleet federation in this change (the knowledge bus is in-process first;
  HTTP transport is a scaffold, not a deployed federation).
- No "AGI" claims; this is a bounded, verifiable, evidence-gated control plane.
- No re-architecture of the Level-3 verified baseline (G1-G7 — done).
- No GUI/dashboard rewrite (Mission Control gains streaming, not a new UI).

## Relationship to prior plans

- `djimitflo-level3-completion` (done, `b8c66f8e`): the architectural track — typed
  capabilities, memory graph, controller, AIMD, handoff, envelope, economy, ship.
- `self-learning-swarm-maturation` (Phase 0 done): the operational track — deterministic
  gate, wiki transfer, opencode parity, scale>2, hygiene.
- **This plan** is the **production track** — crash safety, runtime adaptation, cognitive
  memory, dollar economy, live observability, continuous operation. It composes with both:
  Level-3 provides the architecture, maturation keeps the gate green, this raises the
  system from "verified runtime" to "production OS."
