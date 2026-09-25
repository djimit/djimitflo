## Context

DjimFlo v7.0 has 165+ services, 1410+ tests, and graph risk 0.00. The architecture is decomposed into 18 communities with clear boundaries. However, the LoopService God Class (4470 LOC, 178 connections, betweenness 0.0325) remains the #1 architectural chokepoint. Additionally, 20 high-degree nodes lack test coverage, the AGI reasoning engine uses templates instead of LLM, and the dashboard lacks AGI visualization.

## Goals / Non-Goals

**Goals:**
- Reduce LoopService from 4470 to <1500 LOC via facade + extraction pattern
- Achieve >95% test coverage on critical path (currently ~60%)
- Upgrade AGI reasoning from template-based to LLM-powered
- Add real-time WebSocket streaming for consensus debates
- Build 4 AGI dashboard components (reasoning, consensus, predictive, healing)

**Non-Goals:**
- No changes to external HTTP API contracts
- No new npm dependencies
- No production deployment
- No changes to governance benchmark or legal RuleOps

## Decisions

### D1 — Facade Pattern for LoopService Decomposition
**Decision**: Keep LoopService class as a thin facade that delegates to LoopLifecycleService and LoopVerificationService.
**Rationale**: All 178 callers import LoopService. Changing every caller in one pass is high-risk. Facade allows incremental migration: extract internals, tests still pass, callers unchanged.
**Trade-off**: Temporary indirection layer. Removed once all callers migrate.

### D2 — Test-First Extraction
**Decision**: Write integration tests for each method BEFORE extracting it from LoopService.
**Rationale**: Tests provide safety net. Extraction without tests risks regression.
**Trade-off**: Slower initial progress, but zero regression risk.

### D3 — LLM Integration via Existing LlmRouterService
**Decision**: Use the existing LlmRouterService (5-provider routing) for AGI reasoning instead of adding new LLM dependencies.
**Rationale**: Reuses existing infrastructure. LlmRouterService already handles provider selection, failover, and cost optimization.
**Trade-off**: Limited to providers configured in LlmRouterService. Acceptable for v8.

### D4 — WebSocket Transport for Consensus
**Decision**: Add WebSocket transport alongside existing HTTP for consensus debates.
**Rationale**: Real-time streaming requires persistent connection. HTTP polling is inefficient for live debates.
**Trade-off**: Adds complexity (connection management, reconnection). Mitigated by existing WebSocketService infrastructure.

### D5 — Dashboard Components as Lazy-Loaded Routes
**Decision**: AGI dashboard components are lazy-loaded React routes, not bundled in main bundle.
**Rationale**: Reduces initial bundle size. AGI features are power-user features, not core workflow.
**Trade-off**: Slight delay on first load. Acceptable with proper loading states.

## Risks / Trade-offs

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LoopService extraction breaks existing tests | Low | High | Test-first approach, facade pattern |
| LLM calls add latency to goal reasoning | Medium | Low | Async processing with fallback to templates |
| WebSocket connections overload server | Low | Medium | Connection limits, heartbeat, auto-disconnect |
| Dashboard components increase bundle size | Low | Low | Lazy loading, code splitting |
| God Class decomposition takes longer than estimated | Medium | Medium | Incremental extraction, stop at 1500 LOC target |

## Architecture Changes

### Before (Current)
```
LoopService (4470 LOC)
  ├── Lifecycle methods (~800 LOC)
  ├── Execution methods (~1200 LOC)
  ├── Verification methods (~800 LOC)
  ├── Budget methods (~400 LOC) — already extracted
  ├── Worktree methods (~200 LOC) — already extracted
  ├── Goal methods (~100 LOC) — already extracted
  └── Private helpers (~970 LOC)
```

### After (Target)
```
LoopService (1500 LOC) — Facade
  ├── Delegates to LoopLifecycleService (~800 LOC)
  │   ├── startLoop, continueLoopRun, stopLoopRun
  │   ├── recoverInterruptedRuns, resumeInterruptedRun
  │   └── Private helpers
  ├── Delegates to LoopVerificationService (~400 LOC)
  │   ├── verifyLoopRun, certifyLoopRun, completeLoopRun
  │   ├── submitCheckerVerdict, submitSecurityVerdict
  │   └── Gate evaluation logic
  ├── Budget methods — delegated to LoopBudgetService (existing)
  ├── Worktree methods — delegated to WorktreeManager (existing)
  └── Goal methods — delegated to GoalService (existing)
```

### Data Flow (AGI Reasoning)
```
User Goal (NL)
    ↓
AgiGoalReasoningEngine
    ↓
LlmRouterService → Best Provider (Anthropic/OpenAI/Google/Ollama)
    ↓
LLM Response (structured JSON)
    ↓
Strategy Decomposition → StrategyNode[]
    ↓
CognitiveLoopClosureService → Episode Recording
    ↓
Pattern Extraction → Future Learning
```

### Real-Time Consensus Flow
```
Agent A → POST /api/agi/consensus/debates/:id/proposals
    ↓
MultiAgentConsensusService
    ↓
WebSocket Broadcast → All subscribed clients
    ↓
Dashboard: Live debate visualization
    ↓
Agent B → POST /api/agi/consensus/debates/:id/vote
    ↓
Score Update → WebSocket Broadcast
    ↓
Dashboard: Live vote tally
```
