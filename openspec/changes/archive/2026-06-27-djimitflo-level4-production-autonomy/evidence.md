# Evidence — Level-4 Production Autonomy

## Level-3 verified baseline (on `origin/main` through `b8c66f8e`, do not regress)

### G1-G7 (all verified, see `djimitflo-level3-completion/closure.md`)
- **G1 Typed capabilities**: `measureCompetence()`, `autoPromoteFromEvidence()`, auto-deprecation, competence-aware `planLoopRun`
- **G2 Memory graph**: provenance (`provenance_run` + `evidence_refs`), trust decay (30-day half-life), contradiction (`contradicts_ref`)
- **G3 Controller**: `planLoopRun()` (findings→capability DAG), scheduler uses planner, feedback law (retry on gate-fail), `certifyLoopRun()`
- **G4 Scale**: AIMD (`adjustConcurrency`, `dynamicLimit`, +1/×0.5)
- **G5 Handoff**: sub-agent `createClaim` with `created_from: 'g5_handoff'`, `injected_memory_trust_scores`, `low_trust_memory` gate
- **G6 Envelope**: bwrap sandbox wrapper, gitleaks CI, learned cost model, checker-verifies-memory prompt
- **G7 Ship**: real-issue demo (JSDoc on `certifyLoopRun`), `PRODUCTION_PASSED=true`, `missing=[]`, host untouched

### Existing seams the Level-4 plan reuses (no greenfield)

| Seam | Location | Level-4 use |
|---|---|---|
| `MemoryCandidateService` | `memory-candidate-service.ts` (323 lines) | G8: add `store` param + routing |
| `ContextInjectionService.searchQdrantSwarm` | `context-injection-service.ts` (244 lines) | G8: filter by store |
| `runtimeSemaphoreHardCap` / `adjustConcurrency` | `loop-service.ts:4680-4710` | G9: couple to fleetPools via callback |
| `fleetPools().recommended_concurrency` | `swarm-status-service.ts:771` | G9: the capacity source |
| `recoverInterruptedRuns` | `loop-service.ts:481` | G10: extend with resume |
| `loop_checkpoints` | DB table + `AgentAssuranceService` | G10: checkpoint restore |
| `planLoopRun` | `loop-service.ts:1028` | G11: add `selectRuntime` per finding |
| runtime types | `loop-service.ts:156` (codex/opencode/pi/claude/gemini) | G11: runtime selection |
| memory_curator role | `proof-run-service.ts:1098` | G12: evolve to distillation |
| `SwarmCapabilityRecord` | `swarm-intelligence-service.ts` | G12: composed skills |
| `cost_model_json` | `swarm-intelligence-service.ts:36` | G13: add dollars |
| `evaluateTokenBudget` | `loop-service.ts` | G13: extend to `evaluateBudget` |
| observability routes | `routes/observability.ts` | G14: add SSE stream |
| `createClaim` | `swarm-intelligence-service.ts` | G15: publish to bus |
| `goals` table + `POST /goals` | `routes/goals.ts` + `loop-service.ts` | G16: goal queue daemon |
| `decomposeGoal` | `loop-service.ts:702` | G16: daemon uses this |
| gitleaks CI | `.github/workflows/secret-scan.yml` | G17: verify after purge |

## Level-3 remainder (the 5 deferred sub-tasks this plan closes)

| Task | Gap | Closed by |
|---|---|---|
| T2.1 | 4-store memory not labeled/routed | G8 |
| T2.5 | Vector store as index not formalized | G8 (T8.4) |
| T4.1 | Resource envelope incomplete (no dollars/CPU/mem; fleetPools not coupled) | G9 |
| T4.3 | No graceful scale-down (checkpoint-and-drain) | G9 (T9.3) |
| T5.3 | Cross-fleet knowledge bus deferred | G15 |

## Ship criteria (G18 — the gate that means "production-ready")

A **real, multi-step production goal** is resolved by the Level-4 swarm:
- the goal enters via the **queue** (G16); is **decomposed** by the planner with
  **runtime-adaptive** selection (G11) and **dollar budget** allocation (G13);
- the swarm executes with **AIMD-scaled** concurrency (G4+G9), **crash-safe** (G10),
  **OS-sandboxed** (G6);
- memory is **distilled** into actionable rules (G12) with **4-store** routing (G8);
- the run is **live-observable** via SSE (G14);
- knowledge is published on the **bus** (G15);
- the run is **green** (convergence certificate), **rollback-safe**, **host untouched**;
- the **efficiency metric** (`verified_artifacts / dollar`) is reported;
- the OpenSpec change is archived with evidence.

## What "best agentic OS ever" means (the thesis, concretely)

| Property | Level-3 (done) | Level-4 (this plan) |
|---|---|---|
| Memory | Provenance graph + trust + decay | + 4-store classification + distilled rules + composed skills |
| Scale | AIMD (token-cost) | + fleetPools coupling + dollar budget + graceful drain |
| Recovery | Mark as interrupted | + checkpoint restore + resume + bounded-fail |
| Runtime | Fixed per goal | + adaptive per finding (sovereign/lightweight/complex) |
| Economy | Token cost model | + dollar denomination + budget allocation + refuse-if-not-worth |
| Observability | REST polling | + SSE streaming (real-time AIMD, trust, capabilities, leases) |
| Knowledge | In-process claims | + pub/sub bus + HTTP scaffold for federation |
| Operation | One-shot proofs | + continuous goal queue daemon |
| Safety | bwrap + gitleaks | + secret rotation + history purge |
