# Tasks — Level-3 Completion

> Each Goal is independently shippable + verifiable. Validation is a concrete acceptance
> test, not a feature claim. G0 (deterministic/safe runtime) is DONE (maturation Phase 0).
> The maturation track (`self-learning-swarm-maturation`) keeps the gate green in parallel.

## G1 — Capability + Skill type system

- [ ] T1.1 Define the `Skill` type `(precondition, procedure, expected_effect,
      evidence_schema, cost_model, removal_strategy)`; extend `swarm_capabilities` +
      `SkillService` (seed = the existing capability promotion split candidate/validated).
- [ ] T1.2 Promotion pipeline: a skill-evaluator specialist promotes a `candidate` skill to
      `validated` only after the capability ledger records ≥N validated successes with
      evidence refs (reuses `specialist_reviews` + `supported` claim edges).
- [ ] T1.3 `Specialist := (role, capability_set, policy, learned_competence)`; competence
      measured from `worker_leases` history (success_rate, p50/p95 cost) per capability.
- [ ] T1.4 Competence-aware assignment: the planner scores `(specialist, capability)` and
      assigns within budget (the market). Sub-agent policy = parent ∩ delegated skill
      (intersect allowed / union forbidden), enforced at `NestedSpawnService`.
- [ ] T1.5 Auto-deprecation: a skill whose success_rate drops below threshold OR is
      contradicted is demoted (removal_strategy fires).

Validation (G1):
- A skill is **auto-promoted** from ≥3 validated runs (not hand-authored) and a specialist
  is **assigned to it by competence** (not a fixed role); a green proof uses that skill;
  a contradicted skill is auto-demoted.

## G2 — Memory as a provenance graph

- [ ] T2.1 Classify memory into episodic/procedural/semantic/working; route the flywheel
      write to the right store (procedural→skills/G1, semantic→claims, episodic→run logs,
      working→loop state).
- [ ] T2.2 Provenance: every memory row + every qdrant point carries
      `{claim_id, trust, provenance_run, evidence_refs}`; `ContextInjectionService`
      retrieves *claims with provenance*, not bare excerpts.
- [ ] T2.3 Decay: unvalidated memory trust decays on a half-life; a revalidation event
      refreshes it.
- [ ] T2.4 Contradiction: a `contradicts` edge (claim ledger) demotes the contradicted
      claim; `supersedes` replaces. Reuse `swarm_claims.contradicts_ref/supports_ref`.
- [ ] T2.5 Unify the index: qdrant = retrieval index over the graph; OKF wiki = human
      projection (writeSink okf, gated per maturation Phase 1).

Validation (G2):
- A memory written in run A is retrieved in run B **with its trust + provenance_run +
  evidence_refs visible**; a memory contradicted in run C is demoted and not injected at
  full trust in run D.

## G3 — Goal-directed loop controller

- [ ] T3.1 Planner: `goal → capability DAG` (select capabilities from G1 + dependencies).
      The existing maker/checker/nested shape is the default emitted DAG (backward compat).
- [ ] T3.2 Scheduler: execute the DAG by dependency layer with bounded concurrency
      (`Promise.all` per layer, semaphore-bounded).
- [ ] T3.3 Feedback law: the adaptation table — gate-fail → {retry-higher-competence,
      split, escalate-human, stop}; the circuit breaker is the saturation flag.
- [ ] T3.4 Convergence certificate: generalise `production_passed` to any goal:
      `∀ finding: resolved ∧ checker-accepted ∧ evidence-complete ∧ budget-within ∧
      isolation-held`.

Validation (G3):
- A goal whose DAG has ≥3 distinct capabilities AND ≥1 gate-fail that triggers a
  **retry-with-different-specialist or split** completes green with the certificate; the
  adaptation is observable in the manifests/trace.

## G4 — Scale as resource control

- [ ] T4.1 Resource envelope `R = {tokens, wall_clock, dollars, cpu, mem, gpu}` with hard
      (kill) + soft (throttle) limits; add dollars (G6) + system capacity from
      `swarm-status.fleetPools()`.
- [ ] T4.2 Concurrency controller: AIMD on (pending, budget_remaining, observed_cost,
      capacity), bounded by `fleetPools().recommended_concurrency`; `runtimeSemaphoreLimit`
      becomes the actuator the controller drives (land the deferred coupling at
      loop-service:433).
- [ ] T4.3 Graceful scale-down: checkpoint in-flight leases + drain on budget-exhaustion /
      circuit-break (no mid-artifact SIGKILL without a checkpoint).

Validation (G4):
- Under synthetic load, the swarm **scales concurrency up** (observed lease overlap
  increases) then **scales down gracefully** on budget drain (in-flight leases checkpointed
  + completed or cancelled, not killed mid-artifact); the controller stays within
  `fleetPools().recommended_concurrency`.

## G5 — Knowledge handoff protocol

- [ ] T5.1 Within-run: a sub-agent completes by emitting a **claim + evidence_refs** (not
      raw stdout); the parent's checker verifies the claim against evidence.
- [ ] T5.2 Cross-run: `ContextInjectionService` retrieves claims with trust+provenance; add
      an `injected_memory_trust` gate so the receiver's checker can reject low-trust memory.
- [ ] T5.3 Cross-fleet: pub/sub on typed claims (in-process via `swarm_learning` + the
      claim ledger; HTTP transport when federation lands — non-goal here).

Validation (G5):
- A sub-agent's output reaches its parent as a **verifiable claim** (checker accepts/rejects
  it on evidence); a low-trust memory injected into a run is **rejected by the checker
  gate**; the handoff is observable in the claim ledger.

## G6 — Hard envelope + economy

- [ ] T6.1 Real sandbox: landlock/bubblewrap/firejail (or bind-mount + read-only host +
      no-egress) on the Linux execution node; verify **no absolute-path escape** (a runtime
      cannot write any host path outside its worktree).
- [ ] T6.2 Memory-poisoning defense: checker-verifies promoted claims (T5.1) + decay (T2.3)
      + contradiction (T2.4) + low-trust gating (T5.2).
- [ ] T6.3 Secret hygiene: gitleaks/trufflehog in CI + push protection (on) +
      `MemoryCandidateService.containsSecret` blocks secret memory.
- [ ] T6.4 Cost model: per-capability `cost_model` (p50/p95 tokens, time, dollars) learned
      from `runtime_usage` history; planner (G3) allocates goal budget across the DAG
      (bounded knapsack); efficiency metric `verified_artifacts / dollar`.

Validation (G6):
- A runtime attempting an absolute-path host write is **blocked by the OS sandbox** (not by
  codex's own `--sandbox`); a poisoned memory claim is **rejected/demoted**; a secret in a
  candidate memory is **blocked**; the planner's allocation stays within the goal dollar
  budget and the efficiency metric is reported.

## G7 — Ship (the integration gate)

- [ ] T7.1 Pick a **real, non-trivial goal** (e.g., a real open issue in djimitflo itself:
      "add the pi-executor test + close the Pi sovereign smoke gap").
- [ ] T7.2 Run it via the Level-3 swarm: planner emits a multi-capability DAG, specialists
      assigned by competence, parallel + scaled, skills + memory injected + handoff
      verified, host untouched, learning written back.
- [ ] T7.3 The run is **green** (`production_passed=true` certificate), observable in
      Mission Control, rollback-safe, host `tracked-changed: 0`.
- [ ] T7.4 OpenSpec closure: archive this change + the maturation change with evidence;
      publish the ship demo artifact.

Validation (G7 — the ship gate):
- A real djimitflo issue is **resolved by the swarm** (real diff, tests green, merged via
  human approval), end-to-end, with the certificate + lineage + learning + isolation
  verified. This is "DjimitFlo finished + shipped."

## Ordering + dependencies
G1 (capabilities) → G2 (memory graph, needs G1 for procedural store) → G3 (controller,
needs G1 for the planner) → G4 (scale, needs G3 for the actuator) → G5 (handoff, needs
G2+G3) → G6 (envelope+economy, needs G1 for cost model) → G7 (ship, needs all). G6's
sandbox + secret hygiene can + should land early (safety before trusting the flywheel for
real goals).
