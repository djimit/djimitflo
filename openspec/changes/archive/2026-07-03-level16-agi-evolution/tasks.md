# Tasks — Level-16 AGI Evolution (G108-G119)

> **AUTONOMOUS BUILD**: All goals built in a single run without human-in-the-loop.
> Each goal has automated acceptance tests that must pass before the next goal starts.
> Human validation only at final ship gate (G120).

## Phase 1: Decomposition (G108-G110)

### G108 — LoopPlanningService

- [ ] T108.1 Create `loop-planning-service.ts` with goal CRUD operations
- [ ] T108.2 Extract `selectRuntime()` and `selectRuntimeForCapability()` from LoopService
- [ ] T108.3 Extract all `discover*()` finding methods
- [ ] T108.4 Extract `getLoopContract()`, `getRuntimeContracts()`, `getCatalog()`
- [ ] T108.5 Wire SwarmIntelligenceService and SelfModelService dependencies
- [ ] T108.6 Update LoopService to delegate to LoopPlanningService
- [ ] T108.7 Create test file with ≥ 15 tests
- [ ] T108.8 Verify all existing LoopService tests still pass

Acceptance: LoopPlanningService handles all planning concerns. LoopService LOC reduced by ~800.

### G109 — LoopExecutionService

- [ ] T109.1 Create `loop-execution-service.ts` with maker/worker/checker execution
- [ ] T109.2 Extract `executeMaker()`, `executeWorker()`, `executeChecker()`
- [ ] T109.3 Extract `stepLoopRun()`, `continueLoopRun()`, `retryLoopRun()`, `completeLoopRun()`
- [ ] T109.4 Extract worktree lifecycle management
- [ ] T109.5 Extract `prepareNestedLease()` and nested spawn guards
- [ ] T109.6 Wire AgentAssuranceService and SkillService dependencies
- [ ] T109.7 Update LoopService to delegate to LoopExecutionService
- [ ] T109.8 Create test file with ≥ 15 tests
- [ ] T109.9 Verify all existing LoopService tests still pass

Acceptance: LoopExecutionService handles all execution concerns. LoopService LOC reduced by ~1200.

### G110 — LoopGovernanceService

- [ ] T110.1 Create `loop-governance-service.ts` with gate enforcement
- [ ] T110.2 Extract all `assert*()` gate methods
- [ ] T110.3 Extract budget enforcement (token, dollar, wall-clock)
- [ ] T110.4 Extract `submitCheckerVerdict()`, `submitSecurityVerdict()`
- [ ] T110.5 Extract `runDeterministicChecks()`, `computeLearningCurve()`
- [ ] T110.6 Update LoopService to delegate to LoopGovernanceService
- [ ] T110.7 Create test file with ≥ 15 tests
- [ ] T110.8 Verify all existing LoopService tests still pass

Acceptance: LoopGovernanceService handles all governance. LoopService < 2000 LOC total.

## Phase 2: Metacognition (G111-G113)

### G111 — ReflectionEngine Extension

- [ ] T111.1 Add `analyzeReflectionPatterns()` to ReflectionEngine
- [ ] T111.2 Add `generateMetaLearningProposals()` to ReflectionEngine
- [ ] T111.3 Add `correlateWithOutcomes()` to ReflectionEngine
- [ ] T111.4 Create test file with ≥ 15 tests

Acceptance: ReflectionEngine detects cross-run patterns and generates meta-learning proposals.

### G112 — MetacognitiveObserver

- [ ] T112.1 Create `metacognitive-observer.ts`
- [ ] T112.2 Implement `observeRun()` for real-time reasoning quality
- [ ] T112.3 Implement `detectAnomalies()` for overconfidence detection
- [ ] T112.4 Implement `calibrateConfidence()` per domain
- [ ] T112.5 Create test file with ≥ 12 tests

Acceptance: Observer detects when confidence doesn't match actual outcomes.

### G113 — IntrinsicMotivationModule

- [ ] T113.1 Create `intrinsic-motivation-service.ts`
- [ ] T113.2 Implement `generateNovelGoals()` from knowledge gaps
- [ ] T113.3 Implement `scoreCuriosity()` by novelty distance
- [ ] T113.4 Implement `exploreNewDomain()` for autonomous exploration
- [ ] T113.5 Create test file with ≥ 12 tests

Acceptance: System generates autonomous exploration goals for unknown domains.

## Phase 3: Safety & Federation (G114-G116)

### G114 — AdversarialInputValidator

- [ ] T114.1 Create `adversarial-input-validator.ts`
- [ ] T114.2 Implement `signAndHash()` for input integrity
- [ ] T114.3 Implement `detectPoisoning()` for adversarial detection
- [ ] T114.4 Implement `sanitizeForDisplay()` for XSS prevention
- [ ] T114.5 Create test file with ≥ 12 tests

Acceptance: All external inputs validated and signed before processing.

### G115 — FederationTrustManager

- [ ] T115.1 Create `federation-trust-manager.ts`
- [ ] T115.2 Implement `issueToken()` with scoped capabilities
- [ ] T115.3 Implement `verifyToken()` with expiry and revocation
- [ ] T115.4 Implement `checkRateLimit()` per peer
- [ ] T115.5 Create `federation_tokens` table
- [ ] T115.6 Create test file with ≥ 12 tests

Acceptance: Federation peers authenticated with scoped, revocable tokens.

### G116 — AutonomyRollback

- [ ] T116.1 Create `autonomy-rollback-service.ts`
- [ ] T116.2 Implement `snapshotBeforeMutation()` for rollback capability
- [ ] T116.3 Implement `rollbackToSnapshot()` for safe recovery
- [ ] T116.4 Implement `enforceFilesystemFreeze()` for capability freeze
- [ ] T116.5 Create `mutation_snapshots` table
- [ ] T116.6 Create test file with ≥ 10 tests

Acceptance: Every mutation can be rolled back. Security code is filesystem-frozen.

## Phase 4: Dashboard (G117-G119)

### G117 — RSI Engine Dashboard

- [ ] T117.1 Create `RsiEnginePage.tsx` with refactoring proposals view
- [ ] T117.2 Add safety status panel (mutation budget, frozen components)
- [ ] T117.3 Add specialization matrix visualization
- [ ] T117.4 Add intervention history timeline
- [ ] T117.5 Wire API endpoints to frontend
- [ ] T117.6 Create test file with ≥ 8 tests

Acceptance: All RSI services visible and actionable in dashboard.

### G118 — Expert Swarm Visualizer

- [ ] T118.1 Create `ExpertSwarmPage.tsx` with real-time swarm status
- [ ] T118.2 Add knowledge graph visualization
- [ ] T118.3 Add judge verdict history
- [ ] T118.4 Add source reliability scores
- [ ] T118.5 Wire API endpoints to frontend
- [ ] T118.6 Create test file with ≥ 6 tests

Acceptance: Expert swarm runs visible in real-time with full provenance.

### G119 — Causal Model Explorer

- [ ] T119.1 Create `CausalModelPage.tsx` with intervention log
- [ ] T119.2 Add counterfactual query interface
- [ ] T119.3 Add confidence calibration charts
- [ ] T119.4 Add prediction accuracy tracking
- [ ] T119.5 Wire API endpoints to frontend
- [ ] T119.6 Create test file with ≥ 6 tests

Acceptance: Causal model explorable via interactive queries.

## Phase 5: Ship (G120)

- [ ] G120.1 Run full test suite: all 1150+ tests green
- [ ] G120.2 Run type-check: clean
- [ ] G120.3 Run lint: clean
- [ ] G120.4 Run production proof
- [ ] G120.5 Write closure.md with evidence
- [ ] G120.6 Commit and push

## Execution Order

```
G108 → G109 → G110 → G111 → G112 → G113 → G114 → G115 → G116 → G117 → G118 → G119 → G120
```

Between each goal: run test suite. Fix failures (max 3 attempts). Then proceed.
