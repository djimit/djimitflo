# Design — DjimFlo Level-4 Production Autonomy

## 1. The production framing (the spine)

Level-3 modelled the swarm as a sampled feedback control system. Level-4 models it as a
**production operating system**: a long-running process that accepts work, manages
resources, survives failures, adapts its tools, learns from experience, and is observable
by the operator in real-time.

The key shift: from **one-shot proof runs** to **continuous operation**. The system is no
longer invoked per-goal and terminated — it runs as a daemon, maintains a goal queue,
executes goals as they arrive, and persists state across restarts.

```
┌─────────────────────────────────────────────────────────────┐
│                    DjimFlo Production OS                      │
│                                                               │
│  ┌─────────┐   ┌──────────┐   ┌──────────┐   ┌────────────┐ │
│  │ Goal    │──▶│ Priority │──▶│ Planner  │──▶│ Scheduler  │ │
│  │ Queue   │   │ Scheduler│   │ (G3+G11) │   │ (DAG exec) │ │
│  └─────────┘   └──────────┘   └──────────┘   └─────┬──────┘ │
│                                                     │        │
│  ┌──────────────────────────────────────────────────┘        │
│  │  Runtime Fleet (codex / opencode / pi / claude / gemini)  │
│  │  ┌────────┐ ┌──────────┐ ┌────┐ ┌───────┐ ┌───────┐      │
│  │  │ codex  │ │ opencode │ │ pi │ │ claude│ │ gemini│      │
│  │  │complex │ │lightweight│ │sovr│ │review │ │plan   │      │
│  │  └───┬────┘ └────┬─────┘ └─┬──┘ └───┬───┘ └───┬───┘      │
│  │      └───────────┴─────────┴───────┴─────────┘            │
│  │                    │                                       │
│  │  ┌─────────────────▼────────────────────────┐             │
│  │  │ AIMD Controller (G4+G9)                   │             │
│  │  │ dynamicLimit = f(pending, budget, cost,   │             │
│  │  │   fleetPools().recommended_concurrency)  │             │
│  │  │ + checkpoint-and-drain on exhaustion      │             │
│  │  └──────────────────────────────────────────┘             │
│  │                                                            │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────────┐   │
│  │ Memory      │   │ Skill        │   │ Convergence      │   │
│  │ (4 stores,  │   │ Composer     │   │ Certificate      │   │
│  │  distilled, │   │ (chains)     │   │ (G3.4)           │   │
│  │  trust)     │   │              │   │                  │   │
│  └──────┬──────┘   └──────┬───────┘   └──────────────────┘   │
│         │                 │                                   │
│  ┌──────▼─────────────────▼──────────────────────────────┐   │
│  │ Knowledge Bus (G15) — pub/sub on typed claims          │   │
│  │ in-process → HTTP transport scaffold                    │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐   │
│  │ Live Observability (G14) — SSE stream                   │   │
│  │ AIMD state │ trust scores │ capability transitions │    │   │
│  │ lease lifecycle │ budget burn │ cost-per-artifact      │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐   │
│  │ Crash Recovery (G10) — checkpoint restore on restart    │   │
│  │ detect interrupted → restore lease state → re-queue     │   │
│  │ pending findings → resume or bounded-fail               │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐   │
│  │ Dollar Economy (G13) — cost-per-verified-artifact       │   │
│  │ budget allocation across DAG (bounded knapsack)         │   │
│  │ verified_artifacts / dollar metric                      │   │
│  └────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 2. Memory store formalization (G8)

Four stores, one graph, typed routing:

```
MemoryStore := 'episodic' | 'procedural' | 'semantic' | 'working'

Episodic  → loop_runs, worker_leases, trace_spans, execution_events
            (what happened — immutable, decay-proof, retrieval by time/run)
Procedural → skills (G1) + distilled rules (G12)
            (how to do things — promoted from evidence, retrieval by capability)
Semantic  → swarm_claims (supported/contradicted/superseded) + evidence_edges
            (what is true — trust-weighted, retrieval by claim type + trust)
Working   → loop_checkpoints, assignment packets, current DAG state
            (what's happening now — ephemeral, retrieval by run_id)
```

**Routing**: `MemoryCandidateService.upsertToSwarmMemory` gets a `store` parameter.
The memory_curator classifies the run evidence into the right store:
- run summary → episodic
- distilled rule → procedural
- verified claim → semantic
- current loop state → working

**Retrieval**: `ContextInjectionService.searchQdrantSwarm` filters by `store` in the
payload filter. A maker retrieving knowledge for a capability gets procedural + semantic
(with trust ≥ threshold), not episodic noise.

**Vector store = retrieval index over the graph**: documented + enforced. Every qdrant
point's payload includes `{store, claim_id, trust, provenance_run, evidence_refs}`.
Retrieval returns typed knowledge the receiver can reason about, not bare text.

## 3. Resource envelope + graceful scale-down (G9)

```
ResourceEnvelope := {
  tokens: { spent, soft_limit, hard_limit },
  wall_clock: { elapsed_ms, soft_limit_ms, hard_limit_ms },
  dollars: { spent, soft_limit, hard_limit },          // NEW
  cpu: { available, in_use },                          // NEW (from fleetPools)
  mem: { available_mb, in_use_mb },                    // NEW (from fleetPools)
  gpu: { available, in_use },                          // NEW (from fleetPools)
}
```

**Coupling**: `runtimeSemaphoreHardCap()` calls `fleetPools().recommended_concurrency`
via a callback (injected at construction, not an import — avoids the circular dependency).
The hard cap is `min(env_cap, fleet_recommended)`. The AIMD controller operates within
this cap. On resource pressure (CPU > 80%, mem > 90%), the controller throttles (soft
limit) before the hard cap is reached.

**Graceful scale-down**: on budget exhaustion or circuit-break:
1. Stop accepting new leases (drain the queue).
2. For in-flight leases: wait up to `drain_timeout_ms` (default 60s) for completion.
3. If a lease doesn't complete within the drain timeout: checkpoint its state
   (`loop_checkpoints`) + cancel the child process (SIGTERM, not SIGKILL).
4. Mark the run as `interrupted` with `interrupted_reason: 'budget_drain'`.
5. The run can be resumed (G10) from the checkpoint.

## 4. Crash recovery with resume (G10)

```
onServerStart():
  1. recoverInterruptedRuns() — existing: mark orphaned leases as 'failed'
  2. NEW: for each interrupted run:
     a. Load the last checkpoint (loop_checkpoints WHERE loop_run_id = ? ORDER BY created_at DESC LIMIT 1)
     b. Determine which findings were completed (lease status = 'completed' + checker accepted)
     c. Determine which findings were in-flight (lease status = 'failed' with failed_reason = 'server_restart')
     d. Re-queue in-flight findings as new leases in a new run (or resume the same run if idempotent)
     e. Mark the run as 'running' again
  3. Emit a recovery event (observable in G14)
```

**Idempotency**: a finding is re-queued only if its lease was `failed` (not `completed`).
Completed findings are not re-executed. The checkpoint stores the worktree state diff, so
the resumed lease starts from the last known good state, not from scratch.

**Bounded-fail**: if the run has been interrupted > `max_resume_attempts` (default 3), it's
marked as `failed` (not `interrupted`), and the operator is notified. No infinite retry loop.

## 5. Runtime-adaptive selection (G11)

```
selectRuntime(finding, capability, context): Runtime {
  // Sovereignty check: if the goal requires offline/sovereign execution → pi
  if (context.sovereign || process.env.PI_OFFLINE === '1') return 'pi';

  // Cost-aware: if the capability has a learned cost model and the finding is
  // lightweight (expected tokens < threshold) → opencode (cheaper, faster)
  const costModel = capability.cost_model;
  if (costModel?.learned && costModel.p50_tokens < LIGHTWEIGHT_THRESHOLD) {
    return 'opencode';
  }

  // Competence-aware: if the capability has high competence on codex → codex
  if (capability.metadata.competence?.success_rate > 0.7) {
    return 'codex';
  }

  // Default: codex (the verified baseline)
  return 'codex';
}
```

The planner calls `selectRuntime` per finding instead of reading `run.metadata.runtime`.
This is backward-compatible: if no capability is matched, the default runtime is used.

## 6. Memory distillation + skill composition (G12)

**Distillation**: the memory_curator evolves from "write run summary" to "extract
actionable rules." After a run completes, the curator:
1. Reads the run's evidence (claims, manifests, trace spans, checker verdicts).
2. Uses the runtime (codex, headless, sandboxed) to distill: "given this goal + these
   findings + this approach → this outcome, the actionable rule is: ..."
3. Writes the distilled rule to the **procedural** store with provenance + trust.
4. The rule is retrievable by capability + precondition match.

**Skill composition**: a composed skill is a chain of atomic skills with inter-skill
handoff:

```
ComposedSkill := {
  id, name,
  chain: Array<{ skill_id, handoff_schema }>,
  precondition, expected_effect,
  evidence_schema,
  cost_model: aggregated from chain,
  competence: aggregated from chain,
  removal_strategy,
}
```

A composed skill is promoted when all its atomic skills are `validated` AND the chain has
≥N validated runs. The planner can emit a composed skill as a single DAG node (expanding
it to the chain at execution time) or as individual nodes. This makes the system
accumulate reusable procedures, not re-plan from scratch.

## 7. Dollar economy + budget allocation (G13)

```
CostModel := {
  p50_tokens, p95_tokens,         // existing
  p50_dollars, p95_dollars,        // NEW
  n_runs, success_rate,
  learned: true,
}
```

**Dollar tracking**: each runtime's cost is computed from token usage × price per token
(configurable per runtime: codex=$X/Mtok, opencode=$Y/Mtok, pi=$0). The cost is stored
on the lease's `runtime_usage` metadata and aggregated into the capability's cost model.

**Budget allocation**: the planner allocates the goal's dollar budget across the DAG:
```
maximize: Σ(expected_verified_artifacts_i × competence_i)
subject to: Σ(p50_dollars_i) ≤ goal_dollar_budget
            + per-finding dollar cap
```
This is a bounded knapsack — solved greedily (sort by `competence / p50_dollars`, fill
until budget exhausted). Findings that don't fit the budget are deferred or the goal is
flagged as `budget_insufficient`.

**Efficiency metric**: `verified_artifacts / dollar` — reported per run, per capability,
per specialist. The system can refuse a goal whose expected cost exceeds its value.

## 8. Live observability (G14)

**SSE stream**: `GET /api/observability/stream` — Server-Sent Events stream emitting:
- `aimd_state`: `{ dynamicLimit, active, queue_depth, hard_cap }` on every adjustment
- `trust_change`: `{ claim_id, old_trust, new_trust, reason }` on every trust update
- `capability_transition`: `{ capability_id, old_status, new_status, reason }` on promotion/deprecation
- `lease_lifecycle`: `{ lease_id, role, runtime, status, cost }` on every state transition
- `budget_burn`: `{ run_id, spent_dollars, remaining_dollars, spent_tokens, remaining_tokens }` periodic
- `convergence`: `{ run_id, certified, missing }` on certificate evaluation

**Backpressure**: the stream uses a bounded buffer (default 100 events). If the client
can't keep up, events are dropped (not queued infinitely). A `dropped_events` counter is
reported.

**Mission Control**: the existing REST endpoint gains a `live: true` flag that switches
to SSE. The dashboard can subscribe to the stream and render real-time.

## 9. Cross-fleet knowledge bus foundation (G15)

**In-process pub/sub**: a `KnowledgeBus` class with `publish(claim)` and
`subscribe(capabilityId, callback)`. When a claim is created (via `createClaim`), the bus
publishes it. Subscribers (other loop runs, other capabilities) receive it and can act
(e.g., a planner subscribed to `debugging` claims gets notified when a new debugging
claim is verified).

**HTTP transport scaffold**: `POST /api/knowledge/publish` and
`GET /api/knowledge/subscribe/:capabilityId` (SSE). These are the endpoints a remote
DjimFlo instance would use to join the bus. In this change, they're scaffolded but not
deployed — the bus is in-process first.

## 10. Continuous operation mode (G16)

```
GoalQueueDaemon:
  on start:
    load pending goals from `goals` table (status = 'pending' | 'decomposed')
    sort by (risk_class desc, value desc, estimated_cost asc)

  loop:
    if queue empty: sleep(poll_interval_ms)
    else:
      goal = queue.pop()
      decompose(goal) → capability DAG
      execute(swarm) → convergence certificate
      learn(evidence) → distill rules, update competence
      emit(observability) → live stream
      persist(goal.status = 'completed' | 'failed')
```

The daemon is a new `LoopDaemon` class that wraps `LoopService`. It's started by the
server on boot (after `recoverInterruptedRuns` + resume). It runs in-process, using the
existing `continueLoopRun` machinery. Goals are submitted via the existing `POST /goals`
endpoint.

## 11. Secret rotation + history purge (G17)

1. **Rotate the Qdrant API key**: generate a new key, update the Qdrant container env,
   update all consumers (DjimFlo env, DjimitKBWiki indexer, FastAPI MCP server).
2. **Purge the workstation history**: `git filter-repo --replace-text` to remove the old
   key from all commits in the workstation's DjimitKBWiki + FastAPI MCP commits.
3. **Reconcile**: merge the workstation line into origin (take theirs for conflicting
   files — origin is the superset for DjimFlo, workstation is the source for DjimitKBWiki
   + FastAPI MCP).

## 12. Invariants (extended from Level-3)

- **I1-I7**: (unchanged from Level-3)
- **I8 Crash-safe**: every run can be resumed from its last checkpoint after a restart.
- **I9 Runtime-adaptive**: the runtime is selected by (capability, competence, cost,
  sovereignty), not a fixed field.
- **I10 Cognitive**: memory is distilled rules, not run-summaries; skills are composable.
- **I11 Economically rational**: the cost model is dollar-denominated; the planner
  optimises `verified_artifacts / dollar`.
- **I12 Live-observable**: the operator can watch the swarm execute in real-time.
- **I13 Continuous**: the system runs as a daemon, not a batch processor.

## 13. Risks

- **R1 Distillation quality**: a runtime distilling rules could produce bad rules (the
  memory-poisoning surface, now at the cognitive layer). Mitigation: distilled rules go
  through the same evidence-gated promotion as skills (G1); the checker verifies the rule
  against evidence; trust decay + contradiction apply.
- **R2 Dollar model over-fits**: token prices vary by model; a learned dollar cost from
  few runs is noisy. Mitigation: the dollar cost is a distribution with a prior; the
  planner is robust to noise (satisfices).
- **R3 Continuous mode complexity**: a daemon with a goal queue + crash recovery + live
  streaming is more moving parts. Mitigation: the daemon wraps existing machinery
  (`continueLoopRun`), not new logic; crash recovery reuses `loop_checkpoints`; streaming
  is SSE (no websocket complexity).
- **R4 Scope**: 11 goals is a lot. Mitigation: each goal is independently shippable +
  verifiable; G18 (the ship gate) forces composition; the ordering allows early goals
  (G8, G9, G10) to land before late goals (G15, G16) that depend on them.
- **R5 Fleet coupling**: importing `SwarmStatusService` into `LoopService` creates a
  circular dependency. Mitigation: inject a `ConcurrencyAdvisor` callback at construction,
  not a direct import. The callback is `(() => number | null)` returning the recommended
  concurrency.
