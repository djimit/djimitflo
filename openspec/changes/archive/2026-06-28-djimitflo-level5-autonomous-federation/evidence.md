# Evidence — Level-5 Autonomous Federation

## Verified baseline (on `origin/main` through `a761c67c`, do not regress)

### Level-3 (G1-G7, done) + Level-4 (G8-G18, done) + Level-5 integration (done)
- **G1-G7**: typed capabilities, memory graph, controller, AIMD, handoff, envelope, economy
- **G8-G16**: 4-store memory, resource coupling, crash recovery, runtime selection,
  distillation, dollar economy, live observability, knowledge bus, continuous operation
- **G18**: ship gate (economy endpoint) + production proof green
- **Level-5 integration**: all G8-G18 capabilities wired into the execution path
  (knowledge routes registered, distillFromRun in proof flow, planLoopRun primary path,
  AIMD state persisted, shared LoopService instance)

### Existing seams the Level-5 plan reuses (no greenfield)

| Seam | Location | Level-5 use |
|---|---|---|
| `LoopDaemon` | `loop-daemon.ts` (159 lines) | G19: evolve to ParallelLoopDaemon |
| `knowledgeBus` | `knowledge-bus.ts` (95 lines) | G20: help_request protocol |
| `planLoopRun` | `loop-service.ts:1188` | G21: extend to decomposeGoalToDAG |
| `SSE stream` | `routes/observability.ts` | G22: intervention events |
| `autoPromoteFromEvidence` | `swarm-intelligence-service.ts:409` | G23: capability acquisition |
| `fleetPools()` | `swarm-status-service.ts:771` | G24: resource-aware scheduling |
| `ContextInjectionService` | `context-injection-service.ts` (249 lines) | G25: sanitizeContext |
| `POST /api/knowledge/publish` | `routes/knowledge.ts` | G26: federation transport |
| `NestedSpawnService` | `nested-spawn-service.ts` (624 lines) | G20: spawn help specialists |
| `drainRuntimeLeases` | `loop-service.ts` | G22: pause = drain |
| `resumeInterruptedRun` | `loop-service.ts` | G22: resume = re-queue |
| `system_state` table | `migrate.ts` | G19: persist active goals |

## Ship criteria (G27 — the gate that means "autonomous + federated")

A **real, multi-goal, parallel production scenario** is resolved by the Level-5 swarm:
- 2+ goals execute **concurrently** (G19), each decomposed into a capability DAG (G21);
- agents **negotiate** for help mid-run (G20);
- the operator can **observe + intervene** via SSE + API (G22);
- the system **acquires** new capabilities autonomously (G23);
- goals are **resource-matched** to fleet capacity (G24);
- retrieved context is **sanitized** (G25);
- peers share claims via the **federation protocol** (G26);
- the runs are **green** (convergence certificate), host untouched, economically rational;
- the OpenSpec change is archived with evidence.

## What "autonomous federated agentic OS" means (the thesis, concretely)

| Property | Level-4 (done) | Level-5 (this plan) |
|---|---|---|
| Goals | Serial (one at a time) | **Parallel** (concurrent, AIMD-bounded) |
| Agents | Independent workers | **Negotiating team** (help_request protocol) |
| Decomposition | Predefined loop contracts | **Arbitrary goal → capability DAG** |
| Operator | Observe only (SSE) | **Steerable** (pause/resume/inject/override) |
| Capabilities | Static (manual candidate creation) | **Growing** (autonomous acquisition) |
| Scheduling | Priority only | **Resource-aware** (CPU/GPU/mem matching) |
| Security | Memory-poisoning defense | **+ Prompt injection defense** |
| Scale | Single-node | **Federated** (peer discovery + claim sharing) |
