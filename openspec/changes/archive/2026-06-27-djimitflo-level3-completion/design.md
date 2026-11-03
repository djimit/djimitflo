# Design — DjimitFlo Level-3 Completion

## 1. The control-theoretic framing (the spine)

Model the swarm as a sampled feedback control system over a goal `G`, budget `B`, and time
`t`. State `x_t` = (pending capability invocations, in-flight leases, accumulated evidence,
spent budget). Control `u_t` = (which capability to invoke next, on which specialist, at
what concurrency). The **gates are the control law**: each gate maps the measurement
(usage, diff, deterministic-check, checker-verdict, depth, budget) to an adaptation
{proceed, retry-with-different-specialist, split-finding, escalate-human, stop}. The
**proof is the invariant (certificate)**: at every `t`, the swarm stays inside the
envelope `E = {isolation ∧ budget ∧ evidence ∧ no-auto-merge ∧ no-secret}` and converges
either to a verified artifact (all findings resolved + checker accepted + evidence
complete) or to a **bounded failure** (budget exhausted / human-escalated / circuit-broken)
— never to an unverifiable or unbounded state. This is the Lyapunov-style guarantee that
makes it an *OS*, not a script.

## 2. Capability + Skill type system (G1)

```
Skill := { id, name, precondition, procedure, expected_effect,
           evidence_schema, cost_model, removal_strategy,
           competence: {n_runs, success_rate, p50_cost, p95_cost},
           provenance: promoted_from[] }
Specialist := { role, capability_set: SkillId[], policy, learned_competence }
SubAgent := (parent_lease, delegated_skill, scoped_budget, derived_policy, lineage)
```

- **Promotion, not authoring**: a skill is created by `SkillService.acquire` but only
  *promoted* to `validated` by the **skill-evaluator** specialist after the capability
  ledger records ≥N validated successes with evidence (reuses `swarm_capabilities` +
  `specialist_reviews` + the claim ledger's `supported` edges). Drafts stay `candidate`
  (the existing capability promotion split candidate/validated is the seed).
- **Competence-aware assignment**: the planner scores `(specialist, capability)` by
  `success_rate × expected_effect_match / p50_cost` and assigns within the budget. This is
  a bounded assignment (matching) — the "market".
- **Sub-agent policy derivation**: `derived_policy = parent_policy ∩ delegated_skill.policy`
  (intersect allowed actions, union forbidden) — enforced by `NestedSpawnService`'s depth/
  budget/concurrency gates (already present) + a new policy-intersection check.
- **Removal strategy**: every skill carries an explicit removal/rollback trigger (the
  existing `removal_strategy` field on capabilities) so a skill can be auto-deprecated when
  its success_rate drops or it's contradicted.

## 3. Memory as a provenance graph (G2)

Four stores, one graph:
- **Episodic** → run logs (`loop_runs`, `worker_leases`, `trace_spans`, `execution_events`).
- **Procedural** → skills (G1) + the OKF `skills/` markdown (human-readable projection).
- **Semantic** → the claim ledger (`swarm_claims` with `supported`/`contradicted`/
  `superseded`, `swarm_evidence_edges` linking claims→evidence, `swarm_capabilities`).
- **Working** → the current loop state (`loop_checkpoints`, the assignment packet).

The **graph** = evidence nodes + typed claim edges (supports / contradicts / supersedes) +
trust weights + provenance (every node → the run + lease + artifact that produced it). The
**vector store (`djimitflo_swarm` + `djimit_okf`) is the retrieval index over the graph** —
embedding a claim's excerpt, payload = `{claim_id, trust, provenance_run, evidence_refs}`.
`ContextInjectionService` retrieves *claims with provenance*, not bare text. **Decay**:
unvalidated memories lose trust on a half-life; **contradiction**: a new `contradicts` edge
demotes the contradicted claim's trust (reuses the claim ledger's `contradicts_ref`).
**OKF wiki = the curated human-readable projection** of the semantic store (writeSink okf,
re-added safely per the maturation plan).

## 4. Goal-directed loop controller (G3)

- **Planner**: `goal → capability DAG`. Today `continueLoopRun` picks findings + spawns
  maker/checker for each. The planner generalises: from the goal's findings, select a set
  of capabilities (from G1) + dependencies (a finding may need analyse→fix→verify) → a DAG
  of leases. The current maker/checker/nested shape becomes *one* possible DAG the planner
  can emit (backward compatible).
- **Scheduler**: execute the DAG honouring dependencies + the bounded concurrency
  (`runtimeSemaphoreLimit`) — `Promise.all`-style per dependency layer (the existing
  `executeNestedSpawnProof` concurrency is the primitive).
- **Feedback law**: on each gate result → adapt. The gates already exist
  (`maker_runtime_exit_zero`, `diff_under_threshold`, `token_budget`, `checker_verdict`,
  `worktree_isolation`, `no_automatic_merge`, depth/budget/cycle/concurrency). Add the
  **adaptation table**: gate-fail → {retry with a higher-competence specialist, split the
  finding (the `split` action already exists in `actions_allowed`), escalate to human
  (`human_approval`), stop (circuit breaker — exists)}. The circuit breaker becomes the
  saturation flag of the controller.
- **Convergence certificate**: the proof (`ProofRunService`) generalises from
  artifact-minimums to a **certificate**: `∀ finding: resolved ∧ checker-accepted ∧
  evidence-complete ∧ budget-within ∧ isolation-held`. `production_passed=true` becomes
  the certificate for *any* goal, not only the proof sentinel.

## 5. Scale as resource control (G4)

- **Resource envelope** `R = {tokens, wall_clock, dollars, cpu, mem, gpu}` with hard
  (kill) + soft (throttle) limits. Tokens + wall-clock exist; add dollars (cost model from
  G6) + system capacity (from `swarm-status.fleetPools()` — CPU/mem/GPU already probed).
- **Concurrency controller**: `concurrency_t = clip( f(pending_t, budget_remaining_t,
  observed_cost_t, capacity_t), [1, hard_cap] )`. `f` is a simple AIMD (additive increase
  on success, multiplicative decrease on gate-fail/timeout) bounded by
  `fleetPools().recommended_concurrency` — the deferred coupling (loop-service:433) lands
  here. `runtimeSemaphoreLimit` becomes the *actuator* the controller drives, not a static
  const.
- **Graceful scale-down**: on budget-exhaustion or circuit-break, **checkpoint in-flight
  leases** (`loop_checkpoints` exist) + drain (let completable leases finish, cancel
  queued) — never SIGKILL mid-artifact without a checkpoint. This is the safe scale-down.

## 6. Knowledge handoff protocol (G5)

- **Within-run (sub→parent)**: a sub-agent's lease completes by emitting a **claim +
  evidence_refs** (not raw stdout). The parent's checker verifies the claim against
  evidence (reuses `swarm_claims` + the checker). The handoff is the verified claim.
- **Cross-run (memory)**: `ContextInjectionService` retrieves claims with
  `{trust, provenance_run, evidence_refs}`. The receiver's checker **can reject** memory
  below a trust threshold (a new gate: `injected_memory_trust`). Handoff is not dumping
  context — it's transferring vetted claims.
- **Cross-fleet (knowledge bus)**: a pub/sub on typed claims — specialists publish claims
  (to the semantic store), subscribers retrieve by capability need. In-process first (the
  `swarm_learning` table + the claim ledger); the HTTP control plane (`NestedSpawnService`
  spawn endpoint) is the transport when fleet federation lands (non-goal here).

## 7. Hard envelope + economy (G6)

- **Sandbox**: replace the codex `--sandbox workspace-write` residual (absolute-path
  escape) with a true OS confinement — `landlock`/`bubblewrap`/`firejail` on Linux, or a
  bind-mount worktree + read-only host + no-network egress for sovereign runs. The
  worktree-outside-repo placement (done) is necessary but not sufficient.
- **Memory-poisoning defense**: (a) checker-verifies every promoted memory claim against
  evidence; (b) decay (half-life) demotes unvalidated memory; (c) contradiction
  (`contradicts` edge) demotes; (d) a memory with low trust is injected as
  `unverified` + the receiver's checker gates on it. This closes the self-learning attack
  surface.
- **Secret hygiene**: GitHub push protection (on) + `gitleaks`/`trufflehog` in CI +
  `MemoryCandidateService.containsSecret` (exists) blocks secret persistence in memory.
  (The 2026-06-27 purge of 5 leaked keys across the org is the immediate remediation.)
- **Economy**: per-capability `cost_model` learned from `runtime_usage` history
  (`worker_leases` already store `runtime_usage`); the planner (G3) allocates the goal
  budget across the DAG as a bounded knapsack (maximise expected verified-artifacts subject
  to budget). Efficiency metric = `verified_artifacts / dollar`.

## 8. Invariants (the contract the OS guarantees)

- **I1 Isolation**: no lease mutates outside its worktree (sandbox-enforced, not luck).
- **I2 Bounded**: every run terminates within `R` (hard budget) — success or bounded fail.
- **I3 Evidence-bound**: no accepted artifact without a checker-verified claim + evidence.
- **I4 Lineage-preserving**: every artifact → its spawn tree + leases (already enforced).
- **I5 Non-regressive**: promoted memory/skills are evidence-gated + decay/contradictable.
- **I6 Handoff-trustworthy**: injected knowledge carries trust + provenance; low-trust is
  gateable.
- **I7 Operator-safe**: merge/push/deploy require human approval; secrets never persist.

## 9. Risks

- **R1 Complexity creep**: a planner + scheduler + controller is the classic over-engineering
  trap. Mitigation: the planner emits the *existing* maker/checker DAG as the default; new
  DAGs are opt-in per goal. The controller is AIMD (≈20 lines), not an MPC.
- **R2 Memory poisoning is subtle**: a wrong claim promoted → systemic mislearning.
  Mitigation: I5 + checker-verification + decay; ship G6 defenses before trusting the
  flywheel for real goals.
- **R3 Sandbox portability**: landlock is Linux-only; macOS dev has no equivalent. Mitigation:
  the OS sandbox is a runtime-adapter concern (codex `--sandbox` on dev, landlock/container
  on the Linux execution node); the control plane stays runtime-agnostic.
- **R4 Economic model over-fits**: a learned cost model from few runs is noisy. Mitigation:
  cost_model is a distribution (p50/p95) with a prior; the planner is robust to noise
  (satisfices, doesn't over-optimise).
- **R5 Scope vs ship**: seven goals is a lot. Mitigation: `tasks.md` is ordered so each
  goal is independently shippable + verifiable; G7 (the real-goal ship demo) is the
  integration gate that forces the pillars to compose.
