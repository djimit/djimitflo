# Tasks — Cognitive Loop Closure

## Phase 1: Foundation (Types + DB)

- [x] T1.1 Create OpenSpec change scaffold
- [ ] T1.2 Add shared types: `CognitiveEpisode`, `CognitiveStrategy`, `CognitiveLeaderboardEntry`
- [ ] T1.3 Add database migration for `cognitive_episodes` and `cognitive_strategies` tables

## Phase 2: Services

- [ ] T2.1 Implement `EpisodeService` — record, list, get episodes
- [ ] T2.2 Implement `StrategyService` — score, list, recompute strategies
- [ ] T2.3 Implement `CognitiveRuntimeService` — orchestrate recording + selection

## Phase 3: API + Integration

- [ ] T3.1 Add `/api/cognitive/*` REST routes
- [ ] T3.2 Wire `LoopService` to emit episodes on loop completion
- [ ] T3.3 Register routes in `createRoutes`

## Phase 4: Dashboard

- [ ] T4.1 Add `CognitiveRuntimePage` — episodes list, strategy leaderboard, learning curve
- [ ] T4.2 Add route to `App.tsx`

## Phase 5: Tests + Verification

- [x] T5.1 Integration tests for `CognitiveLoopClosureService` (7 tests — event recording, pattern extraction, strategy evolution)
- [x] T5.2 Route mount test for `createCognitiveRoutes`
- [x] T5.3 Execution engine integration tests (8 tests)
- [x] T5.4 Security fix: execSync timeout on all calls (self-modification-pipeline, diff-capture)
- [x] T5.5 Run full verification suite (1081 tests pass, lint clean, type-check clean)
