# Implementation Tasks

## Phase 1 — Auth Service Hardening (Complete)

- [x] 1.1 Add `setUserActive(id, active)` method to AuthService
- [x] 1.2 Fix auth-service.test.ts to use correct API signatures
- [x] 1.3 Fix authorization.test.ts to use createTestDb()
- [x] 1.4 Remove hardcoded secrets from test files
- [x] 1.5 Verify: 19/19 auth tests passing

## Phase 2 — Test Infrastructure (Complete)

- [x] 2.1 Create `test-helpers/test-db.ts` with complete schema
- [x] 2.2 Fix 17+ test files to use createTestDb()
- [x] 2.3 Add users, goals, loop_runs, worker_leases tables to test schema
- [x] 2.4 Add 15 performance indexes to test schema

## Phase 3 — Service Hardening (Complete)

- [x] 3.1 Add recordMakerFailure() to LoopService
- [x] 3.2 Add block reason metadata to verifyLoopRun
- [x] 3.3 Add cache eviction to runtimeContractCache
- [x] 3.4 Make BackgroundWorkerService tasks defensive
- [x] 3.5 Add configurable stale lease thresholds

## Phase 4 — Dashboard (Complete)

- [x] 4.1 Create PredictiveAnalyticsPage.tsx
- [x] 4.2 Create SelfHealingPage.tsx
- [x] 4.3 Create AgiReasoningPage.tsx
- [x] 4.4 Create ConsensusDebatePage.tsx
- [x] 4.5 Register all routes in App.tsx

## Phase 5 — Validation (Complete)

- [x] 5.1 Build: clean
- [x] 5.2 Type-check: clean
- [x] 5.3 Lint: clean
- [x] 5.4 Commit and push
- [x] 5.5 Tag v9.0.0-auth-hardening

## Results Summary

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Auth tests passing | 0 | **19** | +19 |
| Authorization tests | 0 | **29** | +29 |
| Test infrastructure | Broken | **Fixed** | ✅ |
| Dashboard AGI views | 2 | **4** | +2 |
| Database indexes | 130 | **140** | +10 |
| Build | clean | **clean** | ✅ |

## Phase 6 — Repository-Wide Correctness Audit (Complete, 2026-07-12)

- [x] 6.1 Restore the combined production server, SPA fallback, auth-protected WebSocket, and same-origin production API contracts
- [x] 6.2 Replace simulated integration health with explicit configured, disabled, healthy, and unavailable states
- [x] 6.3 Restore mission-control API contracts, authenticated SSE, Telegram configuration checks, MCP refresh probes, and cross-platform runtime URL discovery
- [x] 6.4 Correct model-routing, predictive analytics, skill evolution, vector-memory, and swarm execution semantics; add deterministic AI correctness tests
- [x] 6.5 Make the dashboard responsive, remove fabricated metrics, align displayed versions, and split secondary pages into production chunks
- [x] 6.6 Validate the production build in a real browser on desktop and 390x844 mobile; browser console clean
- [x] 6.7 Validate the complete repository: lint, type-check, build, 1,289 passing tests, dependency tree, zero audit vulnerabilities, and no production source maps
