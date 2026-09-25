# Design — Level-16 AGI Evolution

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    DjimFlo Level-16 Architecture                         │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Dashboard Layer (G117-G119)                    │   │
│  │  RSI Engine │ Expert Swarm Visualizer │ Causal Model Explorer   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│       ↕              ↕                    ↕                            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                 Safety & Federation Layer (G114-G116)             │   │
│  │  AdversarialInputValidator │ FederationTrustManager │ AutonomyRollback│
│  └─────────────────────────────────────────────────────────────────┘   │
│       ↕              ↕                    ↕                            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                  Metacognition Layer (G111-G113)                  │   │
│  │  ReflectionEngine │ MetacognitiveObserver │ IntrinsicMotivation  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│       ↕              ↕                    ↕                            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │              Orchestration Layer (G108-G110)                      │   │
│  │  LoopPlanningService │ LoopExecutionService │ LoopGovernanceService│  │
│  └─────────────────────────────────────────────────────────────────┘   │
│       ↕              ↕                    ↕                            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    LoopService (Facade, ~1500 LOC)                │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│       ↕              ↕                    ↕                            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Shared Infrastructure                          │   │
│  │  Database │ WebSocket │ Auth │ Audit │ Skills │ Knowledge Bus    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Phase 1: Decomposition (G108-G110)

### G108: LoopPlanningService

**File**: `packages/server/src/services/loop-planning-service.ts` (~800 LOC)

**Extracts from LoopService**:
- `createGoal()`, `decomposeGoal()`, `listGoals()`, `getGoal()`, `updateGoal()`
- `selectRuntime()`, `selectRuntimeForCapability()` (from G37)
- `discoverLoopFindings()`, `discoverDocDrift()`, `discoverRepoMaintenance()`
- `discoverResearchQuestions()`, `discoverSkillQuality()`, `discoverMcpConnectorValidation()`
- `getLoopContract()`, `getRuntimeContracts()`, `getCatalog()`

**Interface**:
```typescript
class LoopPlanningService {
  constructor(db: Database, intelligence: SwarmIntelligenceService, selfModel: SelfModelService);

  createGoal(input: GoalCreateInput): GoalRecord;
  decomposeGoal(id: string): { goal: GoalRecord; candidates: DecomposedLoopCandidate[] };
  selectRuntimeForGoal(goalId: string, finding: LoopFinding): string;
  discoverFindings(loopName: LoopName, repoPath: string, maxFindings: number): LoopFinding[];
  getLoopContract(name: string): LoopContract;
  getAvailableRuntimes(): string[];
}
```

**Tests (15+)**:
- Goal creation/decomposition
- Runtime selection with Thompson bandit integration
- Finding discovery per loop type
- Contract resolution
- Graceful degradation when intelligence service unavailable

### G109: LoopExecutionService

**File**: `packages/server/src/services/loop-execution-service.ts` (~1200 LOC)

**Extracts from LoopService**:
- `executeMaker()`, `executeWorker()`, `executeChecker()`
- `stepLoopRun()`, `continueLoopRun()`, `retryLoopRun()`, `completeLoopRun()`
- `planLoopRun()`, `splitLoopRunFinding()`
- `prepareNestedLease()`, `getWorkerLeasePublic()`, `drainRuntimeLeases()`
- Worktree lifecycle management (create, prune, apply patch)

**Interface**:
```typescript
class LoopExecutionService {
  constructor(db: Database, assurance: AgentAssuranceService, skills: SkillService);

  executeMaker(runId: string, input?: ExecuteMakerInput): Promise<ExecuteMakerResult>;
  executeChecker(runId: string, input: ExecuteCheckerInput): Promise<ExecuteCheckerResult>;
  stepLoopRun(runId: string): StepLoopRunResult;
  continueLoopRun(runId: string, input: ContinueLoopInput): ContinueLoopRunResult;
  retryLoopRun(runId: string, input: RetryLoopInput): RetryLoopRunResult;
  completeLoopRun(runId: string, input: CompleteLoopInput): CompleteLoopRunResult;
  prepareNestedLease(input: NestedLeaseInput): NestedLeaseResult;
  drainRuntimeLeases(timeoutMs?: number): Promise<DrainResult>;
}
```

**Tests (15+)**:
- Maker execution happy path
- Checker verdict submission
- Retry with budget enforcement
- Worktree lifecycle (create → patch → prune)
- Nested spawn depth/budget/cycle guards
- Timeout and drain behavior

### G110: LoopGovernanceService

**File**: `packages/server/src/services/loop-governance-service.ts` (~600 LOC)

**Extracts from LoopService**:
- `assertNoFailedGates()`, `assertLoopNotEscalated()`, `assertTokenBudgetAvailable()`
- `assertWallClockBudgetAvailable()`, `evaluateTokenBudget()`
- `getTokenBudget()`, `getDollarBudget()`, `getWallClockBudget()`
- `computeDollarCost()`, `computeDollarsSpent()`, `allocateDollarBudget()`
- `submitCheckerVerdict()`, `submitSecurityVerdict()`, `runDeterministicChecks()`
- `escalateIfFailureThresholdExceeded()`, `computeLearningCurve()`

**Interface**:
```typescript
class LoopGovernanceService {
  constructor(db: Database);

  checkGates(runId: string): GateResult;
  evaluateBudget(runId: string, usage: RuntimeUsage): BudgetDecision;
  submitVerdict(runId: string, input: CheckerVerdictInput): VerdictResult;
  runDeterministicChecks(runId: string, input: RunChecksInput): CheckResult[];
  computeLearningCurve(limit?: number): LearningCurveData;
  enforceMutationBudget(): { allowed: boolean; reason?: string };
}
```

**Tests (15+)**:
- Gate enforcement (pass/fail/escalate)
- Token budget enforcement
- Dollar budget enforcement
- Wall-clock budget enforcement
- Verdict submission and recording
- Learning curve computation
- Mutation budget enforcement

### LoopService Facade (after decomposition)

**File**: `packages/server/src/services/loop-service.ts` (~1500 LOC after)

The facade maintains the original public API but delegates to the 3 services:

```typescript
class LoopService {
  private planning: LoopPlanningService;
  private execution: LoopExecutionService;
  private governance: LoopGovernanceService;

  // Original public methods delegate to appropriate service
  createGoal(input) { return this.planning.createGoal(input); }
  executeMaker(id, input) { return this.execution.executeMaker(id, input); }
  checkGates(id) { return this.governance.checkGates(id); }
  // ... etc
}
```

**Invariant**: No external API changes. All existing tests pass without modification.

## Phase 2: Metacognition (G111-G113)

### G111: ReflectionEngine Extension

**File**: `packages/server/src/services/reflection-engine.ts` (extend existing, +200 LOC)

**New methods**:
```typescript
analyzeReflectionPatterns(limit: number): PatternReport;
generateMetaLearningProposals(): string[];
correlateWithOutcomes(): CorrelationReport;
```

**Algorithm**:
1. Collect last N reflections
2. Cluster lessons learned by topic (keyword extraction)
3. Identify recurring patterns (≥3 occurrences)
4. Generate meta-learning proposals
5. Correlate with actual outcomes

### G112: MetacognitiveObserver

**File**: `packages/server/src/services/metacognitive-observer.ts` (~200 LOC)

```typescript
class MetacognitiveObserver {
  constructor(db: Database, selfModel: SelfModelService);

  observeRun(runId: string): Observation;
  detectAnomalies(runId: string): Anomaly[];
  calibrateConfidence(domain: string): CalibrationResult;
  getReasoningQuality(runId: string): QualityScore;
}
```

**Algorithm**:
1. Monitor reasoning quality per run (confidence vs actual outcome)
2. Detect anomalies (confidence >> actual = overconfidence)
3. Calibrate confidence bins per domain
4. Track trend (improving/stable/degrading)

### G113: IntrinsicMotivationModule

**File**: `packages/server/src/services/intrinsic-motivation-service.ts` (~200 LOC)

```typescript
class IntrinsicMotivationModule {
  constructor(db: Database, curiosity: CuriosityService);

  generateNovelGoals(): GoalRecord[];
  scoreCuriosity(goal: GoalRecord): number;
  exploreNewDomain(domain: string): ExplorationResult;
  getExplorationStats(): ExplorationStats;
}
```

**Algorithm**:
1. Identify knowledge gaps (domains with <3 concepts)
2. Score by novelty (distance from existing knowledge)
3. Generate exploration goals
4. Track exploration success rate

## Phase 3: Safety & Federation (G114-G116)

### G114: AdversarialInputValidator

**File**: `packages/server/src/services/adversarial-input-validator.ts` (~150 LOC)

```typescript
class AdversarialInputValidator {
  validateInput(input: unknown, source: string): ValidationResult;
  signAndHash(input: string): { hash: string; signature: string };
  detectPoisoning(inputs: unknown[]): PoisoningReport;
  sanitizeForDisplay(input: string): string;
}
```

### G115: FederationTrustManager

**File**: `packages/server/src/services/federation-trust-manager.ts` (~200 LOC)

```typescript
class FederationTrustManager {
  constructor(db: Database);

  issueToken(peerId: string, scopes: string[]): FederationToken;
  verifyToken(token: string): VerificationResult;
  revokeToken(tokenId: string): void;
  checkRateLimit(peerId: string): RateLimitResult;
  getTrustedPeers(): FederationPeer[];
}
```

### G116: AutonomyRollback

**File**: `packages/server/src/services/autonomy-rollback-service.ts` (~150 LOC)

```typescript
class AutonomyRollbackService {
  constructor(db: Database, safetyGuard: RsiSafetyGuard);

  snapshotBeforeMutation(componentId: string): Snapshot;
  rollbackToSnapshot(snapshotId: string): RollbackResult;
  enforceFilesystemFreeze(componentId: string): void;
  monitorRewardIntegrity(): RewardIntegrityReport;
}
```

## Phase 4: Dashboard (G117-G119)

### G117: RSI Engine Dashboard

**File**: `packages/dashboard/src/pages/RsiEnginePage.tsx` (~300 LOC)

**Sections**:
- Refactoring proposals (from ServiceRefactoringAnalyzer)
- Safety status (from RsiSafetyGuard)
- Specialization matrix (from EmergentSpecializationService)
- Intervention history (from CausalInferenceService)
- Mutation budget usage

### G118: Expert Swarm Visualizer

**File**: `packages/dashboard/src/pages/ExpertSwarmPage.tsx` (~250 LOC)

**Sections**:
- Active swarms with real-time status
- Knowledge graph visualization
- Judge verdict history
- Source reliability scores

### G119: Causal Model Explorer

**File**: `packages/dashboard/src/pages/CausalModelPage.tsx` (~250 LOC)

**Sections**:
- Intervention log viewer
- Counterfactual query interface
- Confidence calibration charts
- Prediction accuracy over time

## Database Schema (New Tables)

```sql
-- G112: Metacognitive observations
CREATE TABLE IF NOT EXISTS metacognitive_observations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  observation_type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- G113: Exploration goals
CREATE TABLE IF NOT EXISTS exploration_goals (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  curiosity_score REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- G115: Federation tokens
CREATE TABLE IF NOT EXISTS federation_tokens (
  id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- G116: Mutation snapshots
CREATE TABLE IF NOT EXISTS mutation_snapshots (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Invariants

- **I1 API stability**: LoopService public API unchanged after decomposition
- **I2 Test preservation**: All 1050 existing tests remain green
- **I3 Safety boundary**: Security/audit code immutable by self-modification
- **I4 Audit completeness**: Every RSI action logged with full provenance
- **I5 Bounded mutation**: Max 5 self-modifications per day
- **I6 Graceful degradation**: Service failures don't crash the pipeline
