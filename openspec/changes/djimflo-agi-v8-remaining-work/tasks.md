# Implementation Tasks

## Phase 1 — God Class Decomposition (Autonomous, 6u)

- [ ] 1.1 Write integration tests for LoopService lifecycle methods (start, continue, stop, recover)
- [ ] 1.2 Create `LoopLifecycleService` with extracted lifecycle methods
- [ ] 1.3 Wire LoopService.startLoop → LoopLifecycleService.startLoop
- [ ] 1.4 Wire LoopService.continueLoopRun → LoopLifecycleService.continueLoopRun
- [ ] 1.5 Wire LoopService.stopLoopRun → LoopLifecycleService.stopLoopRun
- [ ] 1.6 Wire LoopService.recoverInterruptedRuns → LoopLifecycleService.recoverInterruptedRuns
- [ ] 1.7 Write integration tests for LoopService verification methods (verify, certify, complete)
- [ ] 1.8 Create `LoopVerificationService` with extracted verification methods
- [ ] 1.9 Wire LoopService.verifyLoopRun → LoopVerificationService.verifyLoopRun
- [ ] 1.10 Wire LoopService.certifyLoopRun → LoopVerificationService.certifyLoopRun
- [ ] 1.11 Wire LoopService.completeLoopRun → LoopVerificationService.completeLoopRun
- [ ] 1.12 Run full test suite — verify 0 regressions
- [ ] 1.13 Run CodeReviewGraph analysis — verify risk score stable

## Phase 2 — Critical Test Coverage (Autonomous, 4u)

- [ ] 2.1 Write createError unit tests (all error codes, status mappings, edge cases)
- [ ] 2.2 Write errorHandler integration tests (production vs dev behavior, stack trace filtering)
- [ ] 2.3 Write main() integration tests (server startup, route registration, graceful shutdown)
- [ ] 2.4 Write seed.ts tests (database seeding with various configurations)
- [ ] 2.5 Write tests for top-10 untested hotspots (by graph degree)
- [ ] 2.6 Run full test suite — verify >1500 tests, 0 new failures

## Phase 3 — LLM-Powered Reasoning (Autonomous, 8u)

- [ ] 3.1 Enhance AgiGoalReasoningEngine with LLM integration via LlmRouterService
- [ ] 3.2 Implement LLM prompt template for goal decomposition
- [ ] 3.3 Implement response validation (JSON schema, circular dependency check)
- [ ] 3.4 Implement template fallback when LLM unavailable
- [ ] 3.5 Add self-reflection capability (LLM evaluates its own reasoning)
- [ ] 3.6 Integrate with CognitiveLoopClosureService for episode recording
- [ ] 3.7 Write tests for LLM reasoning (mock LLM responses)
- [ ] 3.8 Write tests for fallback behavior (LLM unavailable)

## Phase 4 — Real-Time & Visualization (Autonomous, 6u)

- [ ] 4.1 Add WebSocket endpoint `/ws/consensus/:debateId` to existing WebSocketService
- [ ] 4.2 Implement debate event broadcasting (proposal, vote, resolution)
- [ ] 4.3 Implement connection management (limit, heartbeat, cleanup)
- [ ] 4.4 Create AGIReasoningPage.tsx with reasoning flow visualization
- [ ] 4.5 Create ConsensusDebatePage.tsx with live debate viewer
- [ ] 4.6 Create PredictiveAnalyticsPage.tsx with charts and forecasts
- [ ] 4.7 Create SelfHealingPage.tsx with health checks and incident history
- [ ] 4.8 Add lazy-loaded routes for all AGI pages
- [ ] 4.9 Write tests for WebSocket consensus streaming
- [ ] 4.10 Write tests for dashboard components (render, interact, update)

## Validation & Ship Gate

- [ ] V.1 Run `npm run type-check` — clean across all workspaces
- [ ] V.2 Run `npm run lint` — clean across all workspaces
- [ ] V.3 Run `npm run build` — all workspaces build successfully
- [ ] V.4 Run `npx vitest run` — >1500 tests, 0 failures
- [ ] V.5 Verify LoopService <1500 LOC
- [ ] V.6 Verify <5 untested hotspots remain
- [ ] V.7 Verify graph risk score 0.00
- [ ] V.8 Generate release notes from commits
- [ ] V.9 Tag release v8.0.0
- [ ] V.10 Push to origin/main
