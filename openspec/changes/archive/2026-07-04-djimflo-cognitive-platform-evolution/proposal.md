## Why

OpenMythos Governance Audit (v1.0, 2026-07-04) identified 7 critical architectural gaps and 12 strategic improvement vectors separating DjimFlo from a "working system" and a "cognitive platform." This change implements all audit findings as 4 autonomous-executable phases with human approval gates.

**Audit findings summary:**
- 20 untested critical hotspots (blast radius 99-456 edges)
- 4 God Classes remaining (>1400 LOC each)
- No runtime governance enforcement
- No cognitive loop closure (no cross-episode learning)
- Self-modification pipeline is empty scaffold
- Memory is reactive, not proactive
- No fleet-wide agent coordination

## What Changes

### Phase 1 — Foundation (Autonomous, 40u)
- **F1.1:** Integration tests for 10 untested critical hotspots (createDiscussionRoutes, createTaskRoutes, createLoopRoutes, main, seed, ApiClient.request, SwarmIntelligenceService, createApprovalRoutes, createRuntimeProofRun, createRoutes)
- **F1.2:** Decompose SwarmIntelligenceService (1855 LOC → 4 services: MissionService, DecisionService, HypothesisService, ClaimService)
- **F1.3:** Runtime governance enforcement (behavioral telemetry stream + circuit breaker integration)
- **F1.4:** Decompose SwarmStatusService (1626 LOC → 3 services: SchedulerService, WorkerPoolService, HandoffService)

### Phase 2 — Cognition (Autonomous, 45u)
- **F2.1:** Cognitive Loop Closure pipeline (EpisodeRecorder → PatternExtractor → StrategyEvolver → MetaLearningLayer)
- **F2.2:** Proactive Memory Architecture (relevance scoring, auto-promotion, TTL decay, memory graph)
- **F2.3:** Self-Modification Pipeline (analyze → plan → implement → test → evidence-gated PR)

### Phase 3 — Scale (Autonomous, 40u)
- **F3.1:** Fleet-wide Agent Mesh (MCP federation, cross-machine handoff, fleet governance)
- **F3.2:** Multi-Model Intelligence (capability registry, dynamic routing, ensemble validation, cost-aware routing)
- **F3.3:** Compliance & Audit Trail (immutable evidence log, NORA/SOC2 export, audit dashboard)

### Phase 4 — Autonomy (Autonomous, 30u)
- **F4.1:** Agent Retirement Pipeline (graceful decommissioning, evidence archival, lease cleanup)
- **F4.2:** Adversarial Testing (red-team agent that actively probes governance bypass)
- **F4.3:** Full Cognitive Platform Integration (connect all systems into unified cognitive loop)

## Capabilities

### New Capabilities
- `runtime-governance`: Continuous behavioral monitoring and enforcement
- `cognitive-loop-closure`: Cross-episode learning and strategy evolution
- `self-modification`: Autonomous code improvement with evidence gating
- `proactive-memory`: Relevance-scored, self-maintaining memory substrate
- `fleet-mesh`: Cross-machine agent coordination
- `multi-model-intelligence`: Capability-aware model routing
- `compliance-audit`: Enterprise-grade audit trail
- `agent-retirement`: Graceful decommissioning lifecycle

### Modified Capabilities
- `swarm-intelligence`: Decomposed into 4 focused services
- `swarm-status`: Decomposed into 3 focused services
- `loop-service`: Further decomposed (intelligence, status, extraction)
- `governance-guard`: Extended with runtime enforcement

## Impact

- **Affected packages:** `@djimitflo/server` (primary), `@djimitflo/dashboard` (F3.3, F4.3)
- **New dependencies:** None (all additive, using existing patterns)
- **APIs:** New REST endpoints for runtime governance, cognitive loop, self-modification, fleet mesh
- **Database:** New tables for episodes, strategies, memory_graph, fleet_nodes, audit_log
- **Risk:** Medium. Each phase is independently shipable with rollback.
- **Estimated effort:** 155 hours across 4 phases, 12 features.
- **Target maturity:** Level 5/5 "Autonomous Cognition"

## Success Criteria

- <5 untested hotspots (from 20)
- 0 God Classes >800 LOC (from 4)
- Runtime governance blocks violations in <100ms
- Cognitive loop improves success rate by >15% over 10 episodes
- Self-modification produces evidence-gated PR within 24h of improvement identification
- Memory promotion is fully autonomous (zero manual promotion)
- Fleet mesh connects ≥3 machines
- Compliance export passes NORA audit checklist
