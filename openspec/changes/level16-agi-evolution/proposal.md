# Level-16: AGI Evolution — Decomposition, Metacognition, Safety, Dashboard

## Why

DjimFlo Level-15 has 96 services, 1050+ tests, and a working RSI Engine. But the architecture has a critical bottleneck: **LoopService at 5717 LOC with a blast radius of 500 nodes and 136 files**. This makes parallel development, testing, and safe evolution nearly impossible.

Three expert reviews (critic architect, security auditor, code graph analysis) converge on the same conclusion:

1. **Decompose first** — without breaking the monolithic LoopService, no cognitive architecture can scale
2. **Add metacognition** — a system that cannot observe its own reasoning is not AGI, it's a pipeline
3. **Harden safety** — before adding autonomy, the safety layer must be adversarial-grade
4. **Visualize last** — dashboards are useless if the engine underneath is broken

## Thesis

By decomposing LoopService into 3 domain services, adding a metacognition stack with intrinsic motivation, hardening the safety layer with adversarial resilience, and visualizing everything in the dashboard, DjimFlo becomes a **true AGI-grade agentic OS** that can:
- Reason about its own reasoning (metacognition)
- Generate novel goals beyond its training distribution (intrinsic motivation)
- Withstand adversarial inputs and federation attacks (safety)
- Scale horizontally without architectural bottlenecks (decomposition)

## What Changes

### Phase 1: Architectural Decomposition (G108-G110)

**LoopService (5717 LOC) → 3 domain services**

| Goal | Service | Extracts | LOC Target |
|------|---------|----------|------------|
| G108 | LoopPlanningService | Goal decomposition, scheduling, runtime selection, finding discovery | ~800 LOC |
| G109 | LoopExecutionService | Maker/worker/checker execution, worktree lifecycle, lease management | ~1200 LOC |
| G110 | LoopGovernanceService | Gates, approvals, budget enforcement (token/dollar/wall-clock), escalation | ~600 LOC |

LoopService becomes a thin facade (~1500 LOC) that delegates to the 3 services.

### Phase 2: Metacognition & Reflection (G111-G113)

| Goal | Service | Purpose | Tests |
|------|---------|---------|-------|
| G111 | ReflectionEngine (extend) | Cross-run pattern detection, meta-learning from reflections | 15+ |
| G112 | MetacognitiveObserver | Real-time reasoning quality monitoring, confidence calibration | 12+ |
| G113 | IntrinsicMotivationModule | Curiosity-driven exploration, open-ended goal generation | 12+ |

### Phase 3: Safety & Federation (G114-G116)

| Goal | Service | Purpose | Tests |
|------|---------|---------|-------|
| G114 | AdversarialInputValidator | Hash+sign multi-modal inputs, poison detection | 12+ |
| G115 | FederationTrustManager | Capability tokens, mutual TLS, rate limiting for A2A | 12+ |
| G116 | AutonomyRollback | Filesystem-level capability freeze, reward integrity monitor | 10+ |

### Phase 4: Dashboard (G117-G119)

| Goal | Page | Purpose | Tests |
|------|------|---------|-------|
| G117 | RSI Engine Dashboard | Refactoring proposals, safety status, specializations | 8+ |
| G118 | Expert Swarm Visualizer | Real-time swarm status, knowledge graph | 6+ |
| G119 | Causal Model Explorer | Intervention logging, counterfactual queries | 6+ |

## Execution Order

```
G108 → G109 → G110 (Decomposition — remove bottleneck first)
     ↓
G111 → G112 → G113 (Metacognition — add intelligence layer)
     ↓
G114 → G115 → G116 (Safety — harden before autonomy)
     ↓
G117 → G118 → G119 (Dashboard — visualize working system)
```

## Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| LoopService LOC | 5717 | < 2000 |
| Blast radius | 500 nodes | < 200 |
| Untested hotspots | 20 | < 10 |
| Metacognitive capabilities | 0 | 3 |
| Safety guards | 5 | 11 |
| Dashboard pages | 20 | 23 |
| Tests | 1050 | 1150+ |

## Non-Goals

- No SQLite → PostgreSQL migration (SQLite is not the bottleneck)
- No multi-modal hardware integration (deferred to Level-17)
- No full self-replication (ethically unjustified without oversight)
- No infinite recursion (max depth = 3)

## Guardrails

- Each phase must complete with all tests passing before next phase starts
- G108-G110 must not change external API contracts (transparent decomposition)
- G114-G116 must pass security audit before G117-G119 development
- Human validation only at final ship gate (G120)
