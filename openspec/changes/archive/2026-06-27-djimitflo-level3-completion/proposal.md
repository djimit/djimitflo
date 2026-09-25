# DjimitFlo Level-3 Completion — finish + ship the agentic OS

## Why (the real gap, not a feature list)

DjimitFlo today is a **verified runtime** for a real agent swarm (codex specialists run
headless, sandboxed to isolated worktrees, concurrently, with retrieved knowledge + a
self-learning vector flywheel; `production_passed=true`, host never mutated — see
`evidence.md`). That is a Level-1/2 achievement: it **executes** a fixed maker→checker→
nested DAG with a learning side-channel.

It is **not yet an agentic OS**. At Level 3 the gaps are semantic, not operational:

1. **No capability type system.** "Special agent", "sub-agent", "skill" are loose labels.
   `LOOP_CONTRACTS` bind a role to allowed/forbidden actions + gates, but a role is not a
   *typed capability* with a precondition, procedure, expected effect, evidence schema,
   cost distribution, and a *measured competence*. `SkillService` reads OKF `skills/*.md`
   that are **empty** — skills are inert markdown, not promotable, typed, or invokable.
   A sub-agent is just another lease with the same runtime — no delegated capability, no
   scoped policy derivation. The swarm cannot *assign the right specialist to the right
   capability by competence* because competence is unmeasured.

2. **Memory is an unstructured vector bag, not a knowledge structure.** The flywheel embeds
   free-text run-summaries into `djimitflo_swarm` and writes OKF markdown. There is no
   episodic/procedural/semantic/working distinction; no provenance binding a memory to the
   run+evidence that produced it; no decay; no contradiction resolution. The `swarm_claims`
   + `swarm_evidence_edges` tables (a provenance graph skeleton) exist but are only used by
   the proof, not by retrieval. **Handoff is context-dumping, not verified claim transfer**:
   injected memory carries no trust the receiver's checker can reject.

3. **The loop is a workflow, not a controller.** `continueLoopRun` runs a fixed
   maker→checker→(planner∥memory_curator) shape. There is no **planner** that maps a goal
   to a capability DAG, no **scheduler** that executes that DAG with dependencies + bounded
   concurrency, no **feedback law** that adapts on a gate (retry with a different
   specialist / split / escalate / stop), and no **convergence certificate** beyond the
   proof's artifact-minimums. A circuit breaker exists but is a trip, not a control law.

4. **Scale is a static cap, not a control variable.** `runtimeSemaphoreLimit` defaults to 4;
   `max_maker_workers` is per-goal. There is no closed-loop resource controller that sets
   concurrency from (pending work, remaining budget, observed per-agent cost, system
   capacity). `swarm-status.fleetPools().recommended_concurrency` coupling is **deferred**
   (code comment). Scale-down is not graceful (no checkpoint-and-drain on budget exhaustion).

5. **No economic model.** Token/diff budgets are calibrated, but there is no per-capability
   cost distribution learned from history, and the planner does not choose specialists by
   (competence, cost) within a goal budget. Efficiency is a gate, not an objective.

6. **The envelope has a residual.** Codex `--sandbox workspace-write` protects the host
   repo (verified), but a determined runtime can still write via **absolute paths** to other
   writable locations; there is **no real OS sandbox** (landlock/container). And the
   self-learning loop has a **memory-poisoning** attack surface: a bad agent writes a false
   memory → future runs retrieve + act on it. There is no checker-verification of memory
   claims + no decay/contradiction defense.

## The Level-3 thesis

DjimitFlo becomes an agentic OS when five things are true simultaneously:

- **Memory is a provenance graph**, not a vector bag. The vector store is the *retrieval
  index over the graph*; the graph's nodes are evidence, its edges are typed claims
  (supports / contradicts / superseded) with trust + provenance, and its stores are
  episodic / procedural / semantic / working. Handoff = transferring **verified claims**
  (trust + evidence_refs), not text.
- **Skills are typed capabilities promoted from evidence**, not hand-authored markdown. A
  skill is `(precondition, procedure, expected_effect, evidence_schema, cost_model,
  removal_strategy)`; it is promoted by a skill-evaluator only after repeated validated
  success (the capability ledger). A **special agent** = `(role, capability_set, policy,
  learned_competence)`; the swarm assigns agents→capabilities by competence (a market, not
  a fixed role map). A **sub-agent** = a delegated capability invocation with a scoped
  budget + lineage + a policy derived from the parent's.
- **The loop is a goal-directed controller**: planner (goal→capability DAG) → scheduler
  (DAG execution, bounded concurrency, dependencies) → feedback law (gates→adapt:
  retry/split/escalate/stop) → convergence certificate (the proof as a Lyapunov-style
  invariant: the swarm never leaves its budget/isolation/evidence envelope and converges to
  a verified artifact or a bounded failure).
- **Scale is a resource controller**: concurrency is a function of (pending, budget,
  observed cost, capacity) with hard+soft limits and graceful checkpoint-and-drain
  scale-down; coupled to `fleetPools().recommended_concurrency`.
- **The envelope is hard + the economy is real**: a true sandbox (no absolute-path escape),
  memory-poisoning defense (checker-verifies claims, decay, contradiction), secret hygiene
  (push protection + gitleaks CI + the existing secret classifier), and a learned
  per-capability cost model the planner optimises (verified-artifact-per-dollar).

Everything reuses an existing seam (`LOOP_CONTRACTS`, `SwarmIntelligenceService` claims/
evidence_edges/manifests, `NestedSpawnService` depth/budget/concurrency gates,
`MemoryCandidateService` promote + `containsSecret`, `ContextInjectionService`,
`SkillService`, `evaluateTokenBudget`, `runtimeSemaphoreLimit`, the proof certificate,
Mission Control). **No greenfield subsystem; the architecture is a refinement of the
verified runtime into a typed, closed-loop, graph-backed control system.**

## What Changes (the architectural deltas — each is a Goal in `tasks.md`)

- **G1 Capability + Skill type system**: typed skills promoted from the capability ledger;
  special agents bound to capability sets with measured competence; competence-aware
  assignment.
- **G2 Memory as a provenance graph**: 4-store memory + provenance + trust + decay +
  contradiction; vector store = retrieval index over the graph; OKF wiki = human projection.
- **G3 Goal-directed loop controller**: planner + scheduler + feedback law + convergence
  certificate; the fixed DAG becomes a goal-derived capability DAG.
- **G4 Scale as resource control**: resource envelope + closed-loop concurrency +
  graceful scale-down; `fleetPools` coupling.
- **G5 Knowledge handoff protocol**: within-run (sub→parent = claim+evidence, checker
  verifies), cross-run (retrieval with trust/provenance, checker can reject), cross-fleet
  (knowledge bus: publish/subscribe claims by capability).
- **G6 Hard safety envelope + economy**: real sandbox (no absolute-path escape),
  memory-poisoning defense, secret hygiene, learned per-capability cost model + budget
  allocation.
- **G7 Ship**: a non-trivial **real goal** (a real djimitflo issue) executed by a parallel
  specialist swarm with skills+memory+lineage+scale, green, host untouched, learning,
  observable in Mission Control, rollback-safe. OpenSpec closure.

## Non-Goals

- No new runtime (codex/opencode/pi remain the executors; the OS is runtime-agnostic).
- No new DB (the existing graph tables + memory tables are extended, not replaced).
- No "AGI" claims; this is a bounded, verifiable, evidence-gated control plane.
- No re-architecture of the verified isolation/headless/proof baseline (G0 — done).
- No multi-tenant fleet federation in this change (the knowledge bus is in-process first).

## Relationship to the maturation plan
`self-learning-swarm-maturation` (Phase 0 done) is the **operational** track (deterministic
gate, wiki transfer, opencode parity, scale>2, hygiene). This plan is the **architectural**
track that turns the verified runtime into the typed, closed-loop, graph-backed OS. They
compose: maturation keeps the gate green while this raises the ceiling.
