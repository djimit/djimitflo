## Context

DjimFlo v1.0 has achieved:
- 1213 passing tests, 0 failures
- Low architectural risk (0.00)
- Decomposed routes (swarms.ts: 1138→320 lines)
- MCP server with 9 tools
- OpenMythos governance benchmark integration (3 changes)
- NL-driven agent creation
- Visual pipeline builder

The OpenMythos Governance Audit identified the next evolution vector: from "functional governance" to "autonomous cognition."

## Goals / Non-Goals

**Goals:**
- Eliminate all God Classes (>800 LOC)
- Achieve >95% test coverage on critical paths
- Implement runtime governance enforcement
- Build cognitive loop closure (cross-episode learning)
- Enable self-modification with evidence gating
- Deploy proactive memory architecture
- Connect fleet-wide agent mesh
- Achieve enterprise compliance readiness

**Non-Goals:**
- No breaking API changes (additive only)
- No new npm dependencies in Phase 1-2
- No production deployment of self-modification without human approval
- No real-time governance monitoring in Phase 1 (batch-only)

## Decisions

### D1 — Test-First Decomposition
**Decision:** Write integration tests BEFORE decomposing each God Class.
**Rationale:** Tests provide safety net. Decomposition without tests risks regression.
**Trade-off:** Slower initial progress, but zero regression risk.

### D2 — Event-Driven Cognitive Loop
**Decision:** Use swarmEventBus as the backbone for cognitive loop closure.
**Rationale:** Event bus already exists and is the natural integration point.
**Trade-off:** Event ordering guarantees needed for deterministic replay.

### D3 — Evidence-Gated Self-Modification
**Decision:** Self-modification produces PRs, not direct commits. Human approval required for merge.
**Rationale:** Safety. Autonomous code modification is high-risk.
**Trade-off:** Slower improvement cycle, but prevents catastrophic self-modification.

### D4 — Graduated Memory Promotion
**Decision:** Memory promotion uses a 3-tier system: candidate → review → promoted, with auto-promotion for high-relevance scores.
**Rationale:** Balances automation with quality control.
**Trade-off:** Some manual review still required for borderline cases.

### D5 — MCP-First Fleet Mesh
**Decision:** Fleet communication uses MCP protocol (already implemented for local server).
**Rationale:** Reuses existing infrastructure. MCP is becoming the standard.
**Trade-off:** MCP federation is not yet standardized.

## Risks / Trade-offs

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Decomposition breaks existing tests | Low | High | Test-first approach |
| Runtime governance adds latency | Medium | Medium | Async telemetry, batch processing |
| Self-modification produces unsafe code | Low | Critical | Evidence gating + human approval |
| Fleet mesh security concerns | Medium | High | mTLS + capability tokens |
| Memory promotion false positives | Medium | Low | Confidence thresholds + manual review |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    DJIMFLO COGNITIVE PLATFORM                     │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │   Cognitive   │  │   Proactive   │  │    Fleet     │           │
│  │    Loop       │  │   Memory      │  │    Mesh      │           │
│  │   Closure     │  │   Architecture│  │              │           │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘           │
│         │                  │                  │                   │
│  ┌──────┴──────────────────┴──────────────────┴───────┐          │
│  │              swarmEventBus (backbone)                │          │
│  └──────┬──────────────────┬──────────────────┬───────┘          │
│         │                  │                  │                   │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐           │
│  │   Runtime     │  │    Self-      │  │  Compliance  │           │
│  │  Governance   │  │  Modification │  │  Audit Trail │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │              OpenMythos Governance Benchmark              │    │
│  └──────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```
