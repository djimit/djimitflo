## Why

DjimFlo v7.0 (Apex Autonomous Swarm) has achieved 1410+ passing tests, 165+ services, and graph risk 0.00. However, the latest AGI-level analysis identified 5 critical gaps that prevent the platform from reaching its full potential:

1. **LoopService is still 4470 LOC** — The #1 architectural chokepoint (betweenness 0.0325, 178 graph connections). Every code path flows through this God Class, making it the single point of cognitive failure.

2. **20 untested critical hotspots** — `createError` (238 callers), `main()` (99 connections), `seed.ts` (93 connections), and 17 other high-degree nodes have zero test coverage. A failure in any of these cascades to 100+ dependent functions.

3. **Goal reasoning is template-based** — The AGI engine uses hardcoded decomposition patterns instead of LLM-powered reasoning. This limits the platform to predetermined strategies rather than truly autonomous cognition.

4. **No real-time consensus streaming** — The MultiAgentConsensusService uses HTTP polling instead of WebSocket streaming, preventing real-time agent debate visualization.

5. **Dashboard lacks AGI visualization** — The React frontend has no components for goal reasoning, consensus debates, predictive analytics, or self-healing status.

This change addresses all 5 gaps in 4 autonomous-executable phases, with human approval only at the final ship gate.

## What Changes

### Phase 1 — God Class Decomposition (Autonomous, 6u)
- **LoopLifecycleService** — Extract lifecycle methods from LoopService (~800 LOC):
  - `startLoop`, `continueLoopRun`, `stopLoopRun`, `stepLoopRun`
  - `recoverInterruptedRuns`, `resumeInterruptedRun`
  - Goal CRUD delegation to existing GoalService
- **LoopVerificationService** — Extract verification methods (~400 LOC):
  - `verifyLoopRun`, `certifyLoopRun`, `completeLoopRun`
  - `submitCheckerVerdict`, `submitSecurityVerdict`
  - Gate evaluation and escalation logic
- **LoopService facade** — Becomes thin delegation layer (~200 LOC) calling the 2 new services
- **Result**: LoopService reduced from 4470 → ~1500 LOC, blast radius reduced by 60%

### Phase 2 — Critical Test Coverage (Autonomous, 4u)
- **createError tests** — 238 callers, zero tests. Add comprehensive test suite covering all error codes, status mappings, and edge cases
- **main() integration tests** — Server startup, route registration, graceful shutdown
- **seed.ts tests** — Database seeding with various configurations
- **Untested hotspot tests** — Prioritized by graph degree (higher = more critical)
- **Target**: <5 untested hotspots (from 20)

### Phase 3 — LLM-Powered Reasoning (Autonomous, 8u)
- **Enhance AgiGoalReasoningEngine** — Replace template-based decomposition with LLM calls via existing LlmRouterService
- **Autonomous strategy generation** — LLM generates custom strategies based on goal analysis
- **Natural language goal input** — Accept plain-English goals and decompose into executable plans
- **Self-reflection loop** — LLM evaluates its own reasoning quality and suggests improvements
- **Integration with existing CognitiveLoopClosureService** — Feed LLM reasoning outcomes into pattern extraction

### Phase 4 — Real-Time & Visualization (Autonomous, 6u)
- **WebSocket consensus streaming** — Real-time debate updates to dashboard clients
- **AGI Dashboard components** — React components for:
  - Goal reasoning visualization (Observe → Deduce → Plan flow)
  - Consensus debate viewer (live proposals, votes, resolution)
  - Predictive analytics charts (success probability, cost forecasts)
  - Self-healing status dashboard (health checks, incidents, auto-fixes)
- **Human approval gate** — Final review before ship

## Capabilities

### New Capabilities
- `loop-lifecycle-service`: Extracted loop lifecycle management (start/continue/stop/recover)
- `loop-verification-service`: Extracted loop verification and gate evaluation
- `llm-goal-reasoning`: LLM-powered autonomous goal decomposition and strategy generation
- `websocket-consensus`: Real-time consensus debate streaming via WebSocket
- `agi-dashboard`: React components for AGI visualization and monitoring

### Modified Capabilities
- `loop-service-facade`: Thin delegation layer replacing monolithic God Class
- `error-handler`: Now fully tested with 238 caller coverage
- `server-startup`: main() and seed.ts fully integration-tested

## Non-Goals

- No changes to external API contracts (additive only)
- No new npm dependencies (use existing patterns)
- No production deployment (separate change)
- No changes to OpenMythos governance benchmark (already complete)
- No changes to Legal RuleOps UC-06 (already complete)

## Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| **LoopService LOC** | 4470 | <1500 |
| **Untested hotspots** | 20 | <5 |
| **Test count** | 1410 | >1500 |
| **Graph risk** | 0.00 | 0.00 |
| **AGI reasoning** | Template | LLM-powered |
| **Consensus** | HTTP polling | WebSocket streaming |
| **Dashboard AGI views** | 0 | 4 components |

## Impact

- **Affected packages**: `@djimitflo/server` (primary), `@djimitflo/dashboard` (Phase 4)
- **New dependencies**: None
- **APIs**: No breaking changes. New WebSocket endpoint at `/ws/consensus`
- **Risk**: Medium. God Class decomposition is the highest-risk change. Mitigated by: (1) facade pattern preserves existing interface, (2) incremental extraction with tests at each step, (3) rollback via git revert

## Implementation Order

```
Week 1:  Phase 1 (God Class) → Phase 2 (Tests) → Human Gate A
Week 2:  Phase 3 (LLM Reasoning) → Phase 4 (Realtime + Viz) → Final Gate → Ship
```

## Validation Strategy

Each phase validates with:
1. `npm run type-check` — clean
2. `npm run lint` — clean
3. `npm run build` — clean
4. `npx vitest run` — 0 new failures
5. `CodeReviewGraph analysis` — risk score stable or improved

On failure → auto-fix → retry (max 3) → escalate to human.
