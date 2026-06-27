# Tasks — Level-4 Production Autonomy

> Each Goal is independently shippable + verifiable. Validation is a concrete acceptance
> test, not a feature claim. Level-3 (G1-G7) is DONE. This plan extends to G8-G18.
> Ordering: G8 (memory) → G9 (resources) → G10 (crash recovery) → G11 (runtime selection)
> → G12 (distillation + composition) → G13 (economy) → G14 (observability) → G15 (bus)
> → G16 (continuous) → G17 (secrets) → G18 (ship). G17 can + should land early (security).

## G8 — Memory store formalization (T2.1 + T2.5)

- [ ] T8.1 Add `MemoryStore` type (`'episodic' | 'procedural' | 'semantic' | 'working'`)
      to `MemoryCandidateService`; add `store` column to `swarm_memory` table (migration).
- [ ] T8.2 Route the flywheel write by store: run summary → episodic, distilled rule →
      procedural, verified claim → semantic, loop state → working. The memory_curator
      classifies the evidence into the right store before upsert.
- [ ] T8.3 `ContextInjectionService.searchQdrantSwarm` filters by `store` in the payload
      filter. A maker retrieves procedural + semantic (trust ≥ threshold), not episodic.
- [ ] T8.4 Document + enforce: vector store = retrieval index over the graph. Every qdrant
      point payload includes `{store, claim_id, trust, provenance_run, evidence_refs}`.

Validation (G8):
- A memory written as `procedural` in run A is retrieved in run B **only when the maker
  requests procedural knowledge**; an `episodic` memory is NOT returned for a procedural
  query. The store label is visible in the retrieved payload.

## G9 — Resource envelope + graceful scale-down (T4.1 + T4.3)

- [ ] T9.1 Inject a `ConcurrencyAdvisor` callback (`() => number | null`) into
      `LoopService` constructor; `runtimeSemaphoreHardCap()` returns
      `min(env_cap, advisor() ?? env_cap)`. Wire the advisor to
      `SwarmStatusService.fleetPools().recommended_concurrency` at the server composition
      layer (not in LoopService — avoids the circular import).
- [ ] T9.2 Extend `ResourceEnvelope` with `dollars`, `cpu`, `mem`, `gpu` (from fleetPools).
      `evaluateTokenBudget` becomes `evaluateBudget` (tokens + wall_clock + dollars).
- [ ] T9.3 Graceful scale-down: on budget exhaustion or circuit-break → stop accepting new
      leases → wait `drain_timeout_ms` for in-flight leases → checkpoint incomplete leases
      → SIGTERM (not SIGKILL) → mark run `interrupted` with `interrupted_reason:
      'budget_drain'`.

Validation (G9):
- Under synthetic load, the hard cap tracks `fleetPools().recommended_concurrency` (not a
  static 4); on budget drain, in-flight leases are **checkpointed + drained** (not killed
  mid-artifact); the run is `interrupted` (resumable by G10), not `failed`.

## G10 — Crash recovery with resume

- [ ] T10.1 `resumeInterruptedRun(runId)`: load the last checkpoint, determine completed
      vs in-flight findings (by lease status), re-queue in-flight findings as new leases.
- [ ] T10.2 `onServerStart`: call `recoverInterruptedRuns()` (existing) then
      `resumeInterruptedRuns()` for each interrupted run with `resume_attempts <
      max_resume_attempts`.
- [ ] T10.3 Bounded-fail: if `resume_attempts >= max_resume_attempts` (default 3), mark
      the run as `failed` (not `interrupted`) + emit a `recovery_exhausted` event.
- [ ] T10.4 Checkpoint stores the worktree state diff so the resumed lease starts from the
      last known good state.

Validation (G10):
- A run is interrupted mid-maker (server killed); on restart, the run is **resumed from the
  checkpoint** — completed findings are NOT re-executed, in-flight findings are re-queued.
  After ≥3 interrupted resumes, the run is `failed` (bounded).

## G11 — Runtime-adaptive selection

- [ ] T11.1 `selectRuntime(finding, capability, context)`: sovereign → pi, lightweight →
      opencode, complex/high-competence → codex. Called by `planLoopRun` per finding.
- [ ] T11.2 Add `sovereign` flag to `GoalRecord` + `StartLoopInput`; when true, all
      findings route to pi (offline, zero-egress).
- [ ] T11.3 Add `LIGHTWEIGHT_THRESHOLD` (env-configurable, default 5000 tokens): if the
      capability's `p50_tokens < threshold`, route to opencode.

Validation (G11):
- A sovereign goal routes all findings to **pi** (verified: no codex/opencode leases
  created); a lightweight finding routes to **opencode**; a complex finding routes to
  **codex**. The runtime is selected by the planner, not a fixed field.

## G12 — Memory distillation + skill composition

- [ ] T12.1 Evolve the memory_curator: after a run, use the runtime (headless, sandboxed)
      to distill an actionable rule from the run's evidence. Write the rule to the
      **procedural** store with provenance + trust.
- [ ] T12.2 `ComposedSkill` type: a chain of atomic skills with inter-skill handoff
      schema. Stored in `swarm_capabilities` with `composed: true` + `chain: SkillId[]`.
- [ ] T12.3 Promotion: a composed skill is promoted when all atomic skills are `validated`
      AND the chain has ≥N validated runs. The planner can emit a composed skill as a
      single DAG node (expanded at execution time).
- [ ] T12.4 The distilled rule goes through the same evidence-gated promotion as skills
      (G1): checker verifies, trust decay + contradiction apply.

Validation (G12):
- After a completed run, a **distilled actionable rule** is written to the procedural store
  (not a run-summary); the rule is retrievable by capability + precondition in a later run.
  A composed skill (≥2 atomic skills) is **promoted from evidence** and emitted as a single
  DAG node by the planner.

## G13 — Dollar economy + budget allocation

- [ ] T13.1 `CostModel` extended with `p50_dollars`, `p95_dollars`. Each runtime's cost =
      token usage × price per token (configurable: `CODEX_PRICE_PER_MTOK`,
      `OPENCODE_PRICE_PER_MTOK`, `PI_PRICE_PER_MTOK=0`). Stored on lease metadata +
      aggregated into the capability cost model.
- [ ] T13.2 `evaluateBudget` includes dollars. The goal's `dollar_budget` is a required
      field for production goals (default: `GOAL_DOLLAR_BUDGET` env or 10).
- [ ] T13.3 Budget allocation: the planner allocates the goal's dollar budget across the
      DAG (greedy knapsack: sort by `competence / p50_dollars`, fill until budget
      exhausted). Findings that don't fit are deferred; the goal is flagged
      `budget_insufficient` if no findings fit.
- [ ] T13.4 Efficiency metric: `verified_artifacts / dollar` reported per run, per
      capability, per specialist. The system can refuse a goal whose expected cost exceeds
      its value.

Validation (G13):
- A goal with `dollar_budget: 5` has its findings allocated within the budget; the
  efficiency metric (`verified_artifacts / dollar`) is reported; a goal whose expected cost
  exceeds its value is **refused** (flagged `budget_insufficient`).

## G14 — Live observability

- [ ] T14.1 `GET /api/observability/stream` (SSE): emits `aimd_state`, `trust_change`,
      `capability_transition`, `lease_lifecycle`, `budget_burn`, `convergence` events.
- [ ] T14.2 `LoopService` emits events via an `EventEmitter` (or callback); the SSE route
      subscribes. Bounded buffer (100 events); `dropped_events` counter reported.
- [ ] T14.3 Mission Control REST endpoint gains `live: true` flag → switches to SSE.

Validation (G14):
- An SSE client connected to `/api/observability/stream` receives **real-time events** as a
  swarm executes: AIMD adjustments, trust changes, capability transitions, lease lifecycle,
  budget burn. Events arrive within 1s of the action (not polled).

## G15 — Cross-fleet knowledge bus foundation

- [ ] T15.1 `KnowledgeBus` class: `publish(claim)` + `subscribe(capabilityId, callback)`.
      `SwarmIntelligenceService.createClaim` calls `bus.publish(claim)`.
- [ ] T15.2 `POST /api/knowledge/publish` + `GET /api/knowledge/subscribe/:capabilityId`
      (SSE) — HTTP transport scaffold. In-process bus is the default; HTTP is for future
      federation.
- [ ] T15.3 A planner subscribed to a capability receives new verified claims in real-time
      (in-process, no HTTP needed for single-node).

Validation (G15):
- A claim created in run A is **received by a subscriber** (a planner in run B) in
  real-time via the in-process bus; the HTTP endpoints respond (scaffold verified, not
  cross-machine).

## G16 — Continuous operation mode

- [ ] T16.1 `LoopDaemon` class: wraps `LoopService`; on start, loads pending goals, sorts
      by (risk desc, value desc, cost asc); executes in a loop (decompose → execute →
      certify → learn → persist).
- [ ] T16.2 Started by the server on boot (after `recoverInterruptedRuns` +
      `resumeInterruptedRuns`). Runs in-process using existing `continueLoopRun`.
- [ ] T16.3 Goals submitted via `POST /goals` (existing endpoint) enter the queue. The
      daemon polls the queue at `GOAL_QUEUE_POLL_MS` (default 5000).

Validation (G16):
- Two goals submitted to the queue are **executed in priority order** (highest risk/value
  first), each decomposed → executed → certified → learned, without manual intervention.
  The daemon runs continuously across a server restart (goals persist in the DB).

## G17 — Secret rotation + history purge

- [ ] T17.1 Rotate the Qdrant API key: generate a new key, update the Qdrant container env
      (`docker exec qdrant ...`), update all consumers (DjimFlo, DjimitKBWiki, FastAPI MCP).
- [ ] T17.2 `git filter-repo --replace-text` on the workstation's DjimitKBWiki + FastAPI
      MCP commits to remove the old key from all history.
- [ ] T17.3 Reconcile: merge the workstation line into origin (take theirs for conflicting
      files). Verify the old key is NOT in any pushed history.

Validation (G17):
- The old Qdrant key is **not present in any git history** (verified by `git log -p |
  grep`); the new key works (DjimFlo + DjimitKBWiki + FastAPI MCP all connect to Qdrant);
  the workstation line is merged to origin.

## G18 — Ship (the integration gate)

- [ ] T18.1 Pick a **real, multi-step production goal**: e.g., "add a new API endpoint
      `/api/swarms/economy` that reports `verified_artifacts / dollar` per capability + the
      tests + the migration + the docs."
- [ ] T18.2 Run it via the Level-4 swarm: goal queue → planner (runtime-adaptive, budget-
      allocated) → execution (crash-safe, AIMD-scaled, OS-sandboxed) → memory (distilled
      rules, composed skills) → convergence certificate → live-observable → learning
      written back.
- [ ] T18.3 The run is **green** (`production_passed=true` certificate), observable in
      real-time via SSE, rollback-safe, host untouched, economically rational (within
      dollar budget), with distilled memory + composed skills.
- [ ] T18.4 OpenSpec closure: archive this change + the Level-3 change with evidence;
      publish the ship demo artifact.

Validation (G18 — the ship gate):
- A real, multi-step djimitflo goal is **resolved by the Level-4 swarm** (real diff, tests
  green, merged via human approval), end-to-end, with the certificate + lineage + learning
  + isolation + economy + observability verified. This is "DjimFlo production-ready."

## Ordering + dependencies

```
G17 (secrets) ──────────────────────────────────────┐ (land early, security)
G8 (memory stores) ──▶ G12 (distillation, needs G8)  │
G9 (resources) ──▶ G10 (crash recovery, needs G9)    │
G11 (runtime selection) ──▶ G13 (economy, needs G11) │
G14 (observability) ──────────────────────────────────│
G15 (knowledge bus) ──▶ G16 (continuous, needs G15)   │
G18 (ship) needs G8+G9+G10+G11+G12+G13+G14+G15+G16  ◀┘
```
