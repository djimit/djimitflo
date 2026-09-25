# Design — Level-8 Complete Best-of-Breed

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    DjimFlo Level-8 Architecture                          │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Orchestration Layer                           │   │
│  │  LoopService ←→ GOAP Planner ←→ Metacognitive Planner          │   │
│  │       ↕              ↕                    ↕                      │   │
│  │  Thompson Bandit   State Space      Learning Curriculum          │   │
│  │  Operator Intervention                                             │   │
│  │  Control Loop Self-Modification                                    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│       ↕              ↕                    ↕                            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Learning Layer                                │   │
│  │  Self-Model ←→ Search Feedback ←→ Skill Library ←→ Causal DB   │   │
│  │       ↕              ↕                    ↕            ↕         │   │
│  │  Calibration    Reward Tracking    Pattern Store  Edge Graph     │   │
│  │  Influence Attribution                                             │   │
│  │  Competence Awareness                                              │   │
│  │  Theory of Mind                                                    │   │
│  │  Curriculum Learning                                               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│       ↕              ↕                    ↕                            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Memory Layer                                  │   │
│  │  Elastic Memory ←→ Cognitive Patterns ←→ Plugin Registry        │   │
│  │       ↕              ↕                    ↕                      │   │
│  │  Auto-scale      6 patterns         Hot-swap + Witness          │   │
│  │  Multi-modal Perception                                            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│       ↕              ↕                    ↕                            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Trust Layer                                   │   │
│  │  DAG Consensus ←→ Federation ←→ MetaHarness ←→ Competence      │   │
│  │       ↕              ↕              ↕            ↕               │   │
│  │  QR-Avalanche   mTLS + Trust    Audit + Grade  Novel Detection  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Execution Order

```
Phase 0 (G44p): Production Proof + Test Fixes
  ├── Fix 6 pre-existing test failures
  ├── Run production proof
  └── Validate all G35-G44 services active

Phase 1 (G45-G56): Best-of-Breed Features
  ├── G45: Thompson Sampling Bandit
  ├── G46: Search Feedback Loop
  ├── G47: GOAP A* Planner
  ├── G48: Metacognitive Planner
  ├── G49: DAG Consensus
  ├── G50: Federation Protocol
  ├── G51: Plugin Marketplace
  ├── G52: MetaHarness Self-Audit
  ├── G53: Cognitive Memory Patterns
  ├── G54: Elastic Memory
  ├── G55: Influence Attribution
  └── G56: Competence Awareness

Phase 2 (G57-G60): Architecture Evolution
  ├── G57: Skill Marketplace
  ├── G58: Operator Intervention Protocol
  ├── G59: Multi-Modal Perception
  └── G60: Control Loop Self-Modification

Phase 3 (G61-G62): AGI Foundations
  ├── G61: Theory of Mind
  └── G62: Curriculum Learning

Ship (G63): Final validation + production proof
```

---

## Phase 0: Production Proof + Test Fixes (G44p)

### Fix 1: runtime-security.test.ts
**Root cause**: Test expects `--dangerously-bypass-approvals-and-sandbox` flag.
Flag moved to codex-executor.ts. New `buildRuntimeCommand` uses
`--sandbox workspace-write -c approval_policy=never`.
**Fix**: Update test to check new flags.

### Fix 2: runtime-semaphore.test.ts
**Root cause**: `dynamicLimit` is static state not reset between tests.
**Fix**: Extend `resetSemaphore()` with `sem.dynamicLimit = null`.

### Fix 3: g16-continuous-operation.test.ts
**Root cause**: When no findings exist, `goal_completed` is emitted instead
of `goal_started`. Test only checks for `goal_started`.
**Fix**: Update test to also accept `goal_completed`.

### Fix 4: g19-parallel-goals.test.ts (x3)
**Root cause**: Same as G16 — event timing on empty findings.
**Fix**: Update tests to accept `goal_completed` + check `started + completed` count.

### Production Proof
Run `POST /api/proof-runs` with all G35-G44 services active.
Expected: `production_passed: true`.

---

## Phase 1: Best-of-Breed (G45-G56)

### G45: Thompson Sampling Bandit

**File**: `packages/server/src/services/thompson-bandit-service.ts` (~200 LOC)

```typescript
export interface BanditArm {
  runtime: string;
  alpha: number;  // successes + 1
  beta: number;   // failures + 1
}

export class ThompsonBanditService {
  constructor(private db: Database) {}

  selectArm(capabilityId: string): string
  recordOutcome(capabilityId: string, runtime: string, success: boolean): void
  getDistribution(capabilityId: string, runtime: string): BanditArm
  decayAll(factor: number): void
  getArmStats(capabilityId: string): BanditArm[]
}
```

**Algorithm**:
1. For each (capability, runtime): maintain Beta(α, β) where α = successes + 1, β = failures + 1
2. On selection: sample θ_i ~ Beta(α_i, β_i) for each runtime i, pick max θ_i
3. On outcome: α += success, β += failure
4. Decay: every N trials, multiply α, β by 0.95 (recency weighting)

**Integration**: Replace `selectRuntimeForCapability` in `loop-service.ts`.
Fallback to current heuristic when n < 5 per arm.

**Database**:
```sql
CREATE TABLE IF NOT EXISTS thompson_bandits (
  capability_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  alpha REAL NOT NULL DEFAULT 1.0,
  beta REAL NOT NULL DEFAULT 1.0,
  total_trials INTEGER NOT NULL DEFAULT 0,
  last_decay_at TEXT,
  PRIMARY KEY (capability_id, runtime)
);
```

**Tests (15+)**:
- Beta distribution updates correctly on success/failure
- Exploration vs exploitation balance (converges to optimal)
- Decay mechanism reduces old data influence
- Falls back with insufficient data (< 5 trials)
- Converges to optimal runtime in simulation (3 runtimes: sr=0.3, 0.5, 0.7)
- Persistence across service restarts

---

### G46: Search Feedback Loop

**File**: Extend `packages/server/src/services/context-injection-service.ts`

```typescript
recordFeedback(resultId: string, source: string, reward: number): void
getFeedbackWeight(resultId: string): number
pruneOldFeedback(maxDays: number): number
```

**Database**:
```sql
CREATE TABLE IF NOT EXISTS search_feedback (
  id TEXT PRIMARY KEY,
  result_id TEXT NOT NULL,
  source TEXT NOT NULL,
  reward REAL NOT NULL CHECK(reward >= 0 AND reward <= 1),
  capability_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_search_fb_result ON search_feedback(result_id);
CREATE INDEX idx_search_fb_created ON search_feedback(created_at);
```

**Integration**:
- ContextInjectionService records feedback on successful maker completion
  (reward = 1.0 if result referenced in output, 0.1 otherwise)
- ExperienceRetrievalService reads feedback weights for ranking boost
- TTL pruning job (90 days, runs daily)

**Tests (15+)**:
- Feedback recording with valid/invalid rewards
- Weighted ranking boosts frequently-used results
- TTL pruning removes old records
- Integration with context injection pipeline
- Graceful handling of missing feedback

---

### G47: GOAP A* Planner

**File**: `packages/server/src/services/goap-planner-service.ts` (~350 LOC)

```typescript
export interface GOAPAction {
  id: string;
  name: string;
  preconditions: Record<string, boolean>;
  effects: Record<string, boolean>;
  cost: number;
  capabilityId: string;
  runtime: string;
}

export interface GOAPGoal {
  id: string;
  name: string;
  desiredState: Record<string, boolean>;
  priority: number;
}

export interface GOAPPlan {
  actions: GOAPAction[];
  totalCost: number;
  estimatedSuccessRate: number;
}

export class GOAPPlannerService {
  constructor(private db: Database) {}

  plan(goal: GOAPGoal, currentState: Record<string, boolean>, actions: GOAPAction[]): GOAPPlan | null
  replan(goal: GOAPGoal, failedActionId: string, currentState: Record<string, boolean>): GOAPPlan | null
  estimateCost(capabilityId: string): number
  getAvailableActions(capabilityId: string): GOAPAction[]
}
```

**Algorithm**: Standard A* search through state space.
- Heuristic: number of unsatisfied desired states
- Cost: historical average cost per capability
- Actions filtered by preconditions
- Replanning: remove failed action, re-run A* from current state

**Database**:
```sql
CREATE TABLE IF NOT EXISTS goap_actions (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  name TEXT NOT NULL,
  preconditions_json TEXT NOT NULL,
  effects_json TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 1.0,
  success_rate REAL NOT NULL DEFAULT 0.5
);
```

**Integration**:
- LoopService uses GOAP planner for multi-step goals (>= 3 steps)
- Falls back to current keyword matching for simple goals (< 3 steps)
- Replans automatically on action failure

**Tests (20+)**:
- A* finds optimal path in simple graph
- Handles unreachable goals (returns null)
- Precondition checking blocks invalid actions
- Cost-based path selection picks cheapest
- Replanning works after action failure
- State space with 10+ actions performs < 100ms
- Integration with LoopService

---

### G48: Metacognitive Planner

**File**: `packages/server/src/services/metacognitive-planner.ts` (~250 LOC)

```typescript
export interface LearningGoal {
  id: string;
  domain: string;
  objective: string;
  acceptanceCriteria: string[];
  estimatedImpact: number;
  estimatedEffort: number;
  roi: number;
  status: 'proposed' | 'approved' | 'in_progress' | 'completed' | 'failed';
}

export class MetacognitivePlanner {
  constructor(
    private db: Database,
    private selfModel: SelfModelService,
    private goalFormation: GoalFormationService,
  ) {}

  generateLearningCurriculum(): LearningGoal[]
  estimateImpact(gap: KnownUnknown): number
  estimateEffort(gap: KnownUnknown): number
  recordLearningOutcome(goalId: string, outcome: 'success' | 'failure'): void
  adjustStrategy(goalId: string, outcome: 'success' | 'failure'): void
}
```

**Algorithm**:
1. Get known unknowns from Self-Model
2. For each gap: estimate impact (how much closing helps) and effort (how hard)
3. ROI = impact / effort
4. Sort by ROI descending, return top-3
5. On outcome: adjust impact/effort estimates for similar gaps

**Integration**:
- Runs weekly via setInterval
- Creates autonomous goals via Goal Formation service
- Logs learning outcomes to Self-Model snapshots

**Tests (15+)**:
- Gap prioritization by ROI (high impact + low effort first)
- Curriculum generates 1-3 learning goals
- Learning outcome tracking updates estimates
- Strategy adjustment improves future estimates
- Integration with Self-Model and Goal Formation

---

### G49: DAG-Based Evidence Consensus

**File**: `packages/server/src/services/dag-consensus-service.ts` (~200 LOC)

```typescript
export type ConsensusStatus = 'confirmed' | 'falsified' | 'contested' | 'pending';

export class DAGConsensusService {
  constructor(private db: Database) {}

  resolveConsensus(claimId: string): ConsensusStatus
  runConsensusRound(): { confirmed: number; falsified: number; contested: number }
  getConsensusStatus(claimId: string): ConsensusStatus
  getConfidence(claimId: string): number
}
```

**Algorithm** (QR-Avalanche inspired):
1. Get all evidence edges for claim
2. Sum support weight: Σ(source.confidence) for supports edges
3. Sum contradict weight: Σ(source.confidence) for contradicts edges
4. If support > contradict × 1.5 → confirmed
5. If contradict > support × 1.5 → falsified
6. Else → contested (needs more evidence)

**Byzantine tolerance**: As long as < 1/3 of nodes are malicious,
honest majority prevails (weighted by competence).

**Integration**:
- Runs after each loop run completion
- Updates ClaimLedger records with consensus status
- Emits events for newly confirmed/falsified claims

**Tests (15+)**:
- Consensus resolution with clear majority (> 2:1 ratio)
- Tie handling (contested status when ratio < 1.5)
- Weighted voting by source competence
- Byzantine fault tolerance (malicious minority < 1/3)
- Idempotent re-resolution

---

### G50: Federation Protocol

**File**: `packages/server/src/services/federation-service.ts` (~300 LOC)

```typescript
export interface FederationPeer {
  id: string;
  endpoint: string;
  publicKey: string;
  trustScore: number;
  status: 'pending' | 'trusted' | 'untrusted';
  lastSeen: string;
}

export interface FederationMessage {
  id: string;
  peerId: string;
  type: 'capability_discovery' | 'claim_share' | 'skill_share';
  payload: unknown;
  signature: string;
  timestamp: string;
}

export class FederationService {
  constructor(private db: Database) {}

  registerPeer(endpoint: string, publicKey: string): FederationPeer
  sendMessage(peerId: string, type: string, payload: unknown): void
  receiveMessage(message: FederationMessage): void
  calculateTrustScore(peerId: string): number
  discoverCapabilities(): Capability[]
}
```

**PII stripping**: 14-type detection pipeline (emails, SSNs, phone numbers, etc.)
**Trust formula**: 0.4×success + 0.2×uptime + 0.2×threat + 0.2×integrity

**Database**:
```sql
CREATE TABLE IF NOT EXISTS federation_peers (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  public_key TEXT,
  trust_score REAL DEFAULT 0.5,
  last_seen TEXT,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS federation_messages (
  id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  signature TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Tests (15+)**:
- PII stripping detects all 14 types
- Trust score calculation matches formula
- Message signing and verification
- Peer discovery and registration
- Rejection of untrusted messages
- PII-free payload transmission

---

### G51: Plugin Marketplace

**File**: `packages/server/src/services/plugin-registry-service.ts` (~250 LOC)

```typescript
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  dependencies: string[];
  permissions: string[];
  signature: string;
  createdAt: string;
}

export class PluginRegistryService {
  constructor(private db: Database) {}

  installPlugin(manifest: PluginManifest, signature: string): void
  unloadPlugin(pluginId: string): void
  loadPlugin(pluginId: string): void
  verifySignature(manifest: PluginManifest, signature: string): boolean
  listPlugins(): PluginManifest[]
  getPluginStatus(pluginId: string): 'active' | 'inactive' | 'error'
}
```

**Integration**:
- Capabilities table extended with plugin metadata
- REST API for plugin management (list, install, uninstall, verify)
- Integration with MetaEvolution for plugin evaluation

**Tests (15+)**:
- Plugin manifest validation (required fields)
- Signature verification (ed25519)
- Hot-swap without restart (< 1 second downtime)
- Dependency resolution (install dependencies first)
- Version conflict handling

---

### G52: MetaHarness Self-Audit

**File**: `packages/server/src/services/meta-harness-service.ts` (~300 LOC)

```typescript
export interface ReadinessGrade {
  overall: number;       // 0-100
  security: number;      // Config validation, secret detection
  performance: number;   // Latency percentiles, throughput
  coverage: number;      // Test coverage, capability coverage
  reliability: number;   // Uptime, error rates
  compliance: number;    // Audit trail completeness
}

export class MetaHarnessService {
  constructor(private db: Database) {}

  gradeReadiness(): ReadinessGrade
  scanConfig(): ConfigIssue[]
  detectRegressions(baseline: Snapshot): Regression[]
  scanSecurity(): SecurityFinding[]
  getGradeHistory(limit: number): ReadinessGrade[]
}
```

**Grading dimensions**:
- Security: secret detection, permission audit, config validation
- Performance: p50/p95/p99 latency, throughput
- Coverage: test coverage %, capability coverage %
- Reliability: error rate, uptime %
- Compliance: audit trail completeness, evidence retention

**Database**:
```sql
CREATE TABLE IF NOT EXISTS meta_harness_reports (
  id TEXT PRIMARY KEY,
  grade_json TEXT NOT NULL,
  overall_score REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Tests (15+)**:
- Grade calculation covers all 6 dimensions
- Config validation catches misconfigurations
- Regression detection catches injected changes
- Security scan detects test secrets
- Grade history persistence and retrieval

---

### G53: Cognitive Memory Patterns

**File**: `packages/server/src/services/cognitive-memory-service.ts` (~250 LOC)

```typescript
export interface Skill {
  id: string;
  intentEmbedding: Float32Array;
  procedure: Record<string, unknown>;
  successCount: number;
  failCount: number;
  lastUsed: string;
}

export interface CausalEdge {
  id: string;
  causeRef: string;
  effectRef: string;
  strength: number;
  evidenceCount: number;
}

export class CognitiveMemoryService {
  constructor(private db: Database) {}

  storeSkill(intent: string, procedure: Record<string, unknown>): Skill
  retrieveSkills(intent: string, limit: number): Skill[]
  recordSuccess(skillId: string): void
  recordFailure(skillId: string): void
  recordCausalEdge(cause: string, effect: string, strength: number): void
  explainCausation(ref: string): CausalEdge[]
}
```

**Database**:
```sql
CREATE TABLE IF NOT EXISTS skill_library (
  id TEXT PRIMARY KEY,
  intent_embedding BLOB,
  procedure_json TEXT NOT NULL,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  last_used TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS causal_edges (
  id TEXT PRIMARY KEY,
  cause_ref TEXT NOT NULL,
  effect_ref TEXT NOT NULL,
  strength REAL NOT NULL DEFAULT 0.5,
  evidence_count INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Integration**:
- Skill library populated from successful maker trajectories (G40)
- Causal edges created from checker verdicts
- ContextInjectionService retrieves skills alongside memories

**Tests (15+)**:
- Skill storage and retrieval by intent embedding
- Skill success/fail tracking updates rates
- Causal edge creation from observations
- Causal explanation generation (multi-hop)
- Integration with context injection

---

### G54: Elastic Memory Orchestration

**File**: `packages/server/src/services/elastic-memory-service.ts` (~200 LOC)

```typescript
export type MemoryTier = 'hot' | 'warm' | 'cold';

export class ElasticMemoryService {
  constructor(private db: Database) {}

  measureCognitiveLoad(): number
  adjustAllocation(): void
  compressColdData(days: number): number
  getCollectionStats(collectionName: string): CollectionStats
  setTier(collectionName: string, tier: MemoryTier): void
}
```

**Algorithm**:
1. Measure cognitive load from query rates (queries/minute)
2. For each collection:
   - If queryRate > hotThreshold: scale up, set tier = 'hot'
   - If queryRate < warmThreshold: set tier = 'warm'
   - If lastAccess > 30 days: compress, set tier = 'cold'
3. Hysteresis: scale up fast (immediate), scale down slow (1 hour cooldown)

**Tests (15+)**:
- Scale up on high load (query rate > threshold)
- Scale down on low load (query rate < threshold)
- Tier management (hot → warm → cold transitions)
- Compression correctness (data preserved after decompression)
- Hysteresis prevents flapping

---

### G55: Multi-Agent Influence Attribution

**File**: `packages/server/src/services/influence-attribution-service.ts` (~200 LOC)

```typescript
export interface InfluenceRecord {
  leaseId: string;
  loopRunId: string;
  influence: number;  // 0-1, proportion of outcome attributed
  claimsConfirmed: number;
  utility: number;
}

export class InfluenceAttributionService {
  constructor(private db: Database) {}

  attributeInfluence(loopRunId: string): InfluenceRecord[]
  getAgentInfluence(agentId: string, timeRange: DateRange): number
  getTopContributors(loopRunId: string, limit: number): InfluenceRecord[]
}
```

**Algorithm** (Shapley-value inspired):
1. For each agent in the run, get their claims
2. Calculate utility: Σ(claim.confidence) for confirmed claims
3. Influence = agentUtility / totalUtility
4. Update runtime competence with attributed influence

**Database**:
```sql
CREATE TABLE IF NOT EXISTS influence_attribution (
  id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  loop_run_id TEXT NOT NULL,
  influence REAL NOT NULL,
  claims_confirmed INTEGER NOT NULL DEFAULT 0,
  utility REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Integration**:
- Runs after each loop run completion
- Stores influence records for analytics
- Feeds into Thompson Sampling bandit (G45) for runtime selection

**Tests (15+)**:
- Influence calculation for single agent (influence = 1.0)
- Influence distribution across multiple agents (sums to 1.0)
- Shapley fairness property (symmetric agents get equal influence)
- Integration with competence tracking

---

### G56: Competence-Aware Novel Situation Handler

**File**: `packages/server/src/services/competence-awareness-service.ts` (~250 LOC)

```typescript
export type OperationMode = 'normal' | 'cautious' | 'conservative';

export interface NoveltyAssessment {
  isNovel: boolean;
  distance: number;
  nearestCapability: string;
  estimatedCompetence: number;
  recommendedMode: OperationMode;
}

export class CompetenceAwarenessService {
  constructor(private db: Database) {}

  assessNovelty(finding: { type: string; description: string }): NoveltyAssessment
  estimateCompetence(finding: { type: string; description: string }): number
  determineMode(competence: number): OperationMode
  recordOutcome(assessment: NoveltyAssessment, success: boolean): void
}
```

**Algorithm**:
1. Embed finding description
2. Find nearest known capability by embedding similarity
3. If distance < NOVELTY_THRESHOLD (0.3): known situation, normal mode
4. If distance >= NOVELTY_THRESHOLD: novel situation
5. Estimate competence by analogy: weighted average of k-nearest capabilities
6. If estimatedCompetence < 0.3: conservative mode
7. If estimatedCompetence < 0.6: cautious mode
8. Else: normal mode

**Integration**:
- Called by LoopService before processing each finding
- Conservative mode: additional checker review, smaller worktree, human escalation
- Cautious mode: normal processing with extra logging

**Tests (15+)**:
- Novel situation detection (embedding distance > threshold)
- Known situation recognition (embedding distance < threshold)
- Competence estimation by analogy to similar capabilities
- Conservative mode trigger on low competence
- Mode escalation/de-escalation

---

## Phase 2: Architecture Evolution (G57-G60)

### G57: Skill Marketplace

**File**: `packages/server/src/services/skill-marketplace-service.ts` (~250 LOC)

```typescript
export interface SharedSkill {
  id: string;
  name: string;
  version: string;
  procedure: Record<string, unknown>;
  authorInstance: string;
  rating: number;
  ratingCount: number;
  installCount: number;
}

export class SkillMarketplaceService {
  constructor(private db: Database) {}

  publishSkill(skillId: string): void
  searchSkills(intent: string, limit: number): SharedSkill[]
  installSkill(sharedSkillId: string): void
  rateSkill(skillId: string, rating: number): void
  getTrendingSkills(limit: number): SharedSkill[]
}
```

**Difference from G40**: G40 distills skills from trajectories. G57 shares
skills between instances and lets operators publish/remove/reuse skills.

**Database**:
```sql
CREATE TABLE IF NOT EXISTS skill_shares (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  procedure_json TEXT NOT NULL,
  author_instance TEXT NOT NULL,
  rating REAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  install_count INTEGER DEFAULT 0,
  published_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Tests (15+)**:
- Publishing a skill to the marketplace
- Searching skills by intent embedding
- Installing a shared skill (creates local copy)
- Rating a skill (updates average)
- Trending skills by install count

---

### G58: Operator Intervention Protocol

**File**: Extend `packages/server/src/services/operator-intervention.ts` (~200 LOC)

```typescript
export interface InterventionRequest {
  id: string;
  runId: string;
  reason: string;
  context: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

export class OperatorInterventionService {
  constructor(private db: Database) {}

  requestIntervention(runId: string, reason: string, context: Record<string, unknown>): InterventionRequest
  approveIntervention(requestId: string): void
  rejectIntervention(requestId: string, feedback: string): void
  getPendingInterventions(): InterventionRequest[]
  expireIntervention(requestId: string): void
}
```

**Integration**:
- G56 Competence Awareness triggers intervention on low confidence
- Dashboard shows pending interventions
- Operator can approve/reject via API
- Approval resumes the run with elevated privileges
- Rejection logs feedback for future learning

**Database**:
```sql
CREATE TABLE IF NOT EXISTS intervention_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  context_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution TEXT
);
```

**Tests (15+)**:
- Request creation with run context
- Approval flow (status → approved, run resumes)
- Rejection flow (status → rejected, feedback stored)
- Timeout/expiration (pending → expired after 1 hour)
- Integration with G56 Competence Awareness

---

### G59: Multi-Modal Perception

**File**: `packages/server/src/services/multi-modal-perception-service.ts` (~200 LOC)

```typescript
export interface PerceptionResult {
  type: 'screenshot' | 'diagram' | 'text';
  content: string;
  structuredData: Record<string, unknown>;
  confidence: number;
}

export class MultiModalPerceptionService {
  constructor(private db: Database) {}

  async processScreenshot(imagePath: string): Promise<PerceptionResult>
  async processDiagram(imagePath: string): Promise<PerceptionResult>
  async extractTextFromImage(imagePath: string): Promise<string>
  async describeImage(imagePath: string): Promise<string>
}
```

**Integration**:
- Screenshots of dashboard are analyzed for anomalies
- Diagrams in OKF are translated to structural knowledge
- Uses Ollama vision model or LiteLLM multi-modal endpoint
- Graceful degradation if vision model unavailable

**Database**:
```sql
CREATE TABLE IF NOT EXISTS perception_results (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_path TEXT NOT NULL,
  content TEXT NOT NULL,
  structured_data_json TEXT,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Tests (15+)**:
- Screenshot analysis returns structured data
- Diagram understanding extracts components
- OCR text extraction from images
- Graceful degradation when vision model unavailable
- Integration with context injection

---

### G60: Control Loop Self-Modification

**File**: `packages/server/src/services/control-loop-self-modification-service.ts` (~300 LOC)

```typescript
export interface ContractProposal {
  id: string;
  targetContract: string;
  proposedChanges: Record<string, unknown>;
  rationale: string;
  evalScore: number | null;
  status: 'draft' | 'evaluating' | 'approved' | 'applied' | 'rolled_back';
  createdAt: string;
  appliedAt: string | null;
}

export class ControlLoopSelfModificationService {
  constructor(private db: Database) {}

  proposeChange(contractId: string, changes: Record<string, unknown>, rationale: string): ContractProposal
  evaluateProposal(proposalId: string): number
  approveProposal(proposalId: string): void
  applyProposal(proposalId: string): void
  rollbackProposal(proposalId: string): void
  getProposalHistory(contractId: string): ContractProposal[]
}
```

**Safety**:
- All changes start as `draft`
- Evaluation runs against historical data (backtesting)
- Requires eval_score > 0.75 for approval
- Human approval required before application
- Full rollback capability (snapshot before apply)
- Complete audit trail

**Database**:
```sql
CREATE TABLE IF NOT EXISTS contract_proposals (
  id TEXT PRIMARY KEY,
  target_contract TEXT NOT NULL,
  proposed_changes_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  eval_score REAL,
  status TEXT NOT NULL DEFAULT 'draft',
  snapshot_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT,
  rolled_back_at TEXT
);
```

**Tests (15+)**:
- Proposal creation with changes and rationale
- Evaluation against historical data
- Safety gate: draft cannot be applied directly
- Rollback restores previous state
- Audit trail captures all transitions

---

## Phase 3: AGI Foundations (G61-G62)

### G61: Theory of Mind

**File**: `packages/server/src/services/theory-of-mind-service.ts` (~200 LOC)

```typescript
export interface IntentModel {
  agentId: string;
  beliefs: string[];
  goals: string[];
  plannedActions: string[];
  confidence: number;
  lastUpdated: string;
}

export class TheoryOfMindService {
  constructor(private db: Database) {}

  modelAgentIntent(agentId: string, observations: string[]): IntentModel
  predictAgentAction(agentId: string, context: Record<string, unknown>): string
  updateModel(agentId: string, actualAction: string): void
  getIntentModel(agentId: string): IntentModel
}
```

**Algorithm**:
1. Observe agent actions over time (from worker_leases + claim ledger)
2. Build intent model: beliefs (what agent knows), goals (what it pursues), plans (actions taken)
3. Predict next action based on current context + historical patterns
4. Update model on actual observation (Bayesian update)

**Database**:
```sql
CREATE TABLE IF NOT EXISTS agent_intent_models (
  agent_id TEXT PRIMARY KEY,
  beliefs_json TEXT NOT NULL,
  goals_json TEXT NOT NULL,
  planned_actions_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  observation_count INTEGER NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Tests (15+)**:
- Intent modeling from observations
- Action prediction based on context
- Model updating improves accuracy over time
- Multi-agent scenario modeling
- Integration with G55 Influence Attribution

---

### G62: Curriculum Learning

**File**: `packages/server/src/services/curriculum-learning-service.ts` (~200 LOC)

```typescript
export interface CurriculumStep {
  id: string;
  objective: string;
  difficulty: number;
  prerequisites: string[];
  masteryThreshold: number;
  currentMastery: number;
  status: 'locked' | 'available' | 'in_progress' | 'completed';
}

export class CurriculumLearningService {
  constructor(private db: Database) {}

  generateCurriculum(goal: string): CurriculumStep[]
  evaluateMastery(stepId: string): number
  advanceStep(stepId: string): void
  regressStep(stepId: string): void
  getLearningPath(agentId: string): CurriculumStep[]
}
```

**Algorithm**:
1. Break learning goal into ordered steps (prerequisites → advanced)
2. Evaluate mastery per step (success rate on related tasks)
3. Advance when mastery > threshold (0.7)
4. Regress on 3 consecutive failures
5. Generate personalized path based on current competence

**Database**:
```sql
CREATE TABLE IF NOT EXISTS curriculum_steps (
  id TEXT PRIMARY KEY,
  curriculum_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  difficulty REAL NOT NULL DEFAULT 0.5,
  prerequisites_json TEXT NOT NULL,
  mastery_threshold REAL NOT NULL DEFAULT 0.7,
  current_mastery REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'locked',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Tests (15+)**:
- Curriculum generation from goal decomposition
- Mastery evaluation based on task performance
- Advancement when mastery > threshold
- Regression on repeated failure
- Prerequisite enforcement

---

## Invariants (Extended from Level-7)

- **I45 Test-clean**: 0 test failures across all 596+ existing tests
- **I46 Production-verified**: production_passed = true with all services active
- **I47 Bandit-optimal**: converges within 20 trials (80% of simulations)
- **I48 Search-improving**: MRR improves >= 10% after 50 feedback cycles
- **I49 GOAP-optimal**: shortest path in >= 90% of solvable cases
- **I50 Byzantine-tolerant**: consensus tolerates < 1/3 malicious nodes
- **I51 Federation-secure**: 0 PII leaks in federation messages
- **I52 Plugin-integrity**: plugins verified before activation
- **I53 Self-grading**: MetaHarness grade correlates with reliability (r > 0.7)
- **I54 Skill-reusable**: skills succeed >= 70% when reused
- **I55 Causal-accurate**: causal predictions match outcomes >= 60%
- **I56 Memory-elastic**: tiers adjust within 1 hour of load change
- **I57 Influence-fair**: Shapley-value attribution is efficient and symmetric
- **I58 Novelty-aware**: novel situations trigger conservative mode within 100ms
- **I59 Operator-responsive**: intervention request acknowledged within 5 seconds
- **I60 Multi-modal**: screenshots processed with >= 80% accuracy
- **I61 Self-modifying**: contract changes applied safely with rollback
- **I62 Theory-of-mind**: action prediction accuracy >= 60%
- **I63 Curriculum**: mastery advances correctly, regresses on failure

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| R1 Bandit cold start | Fallback to heuristic until n >= 5 per arm |
| R2 GOAP state explosion | Limit action set to top-10 capabilities per goal |
| R3 Federation security | mTLS + PII stripping + trust scoring |
| R4 Plugin integrity | Signature verification + sandbox |
| R5 Memory elasticity disruption | Hysteresis: scale up fast, scale down slow |
| R6 Novelty false positives | Tune threshold on historical data |
| R7 Self-modification safety | Draft → eval → human → apply + rollback |
| R8 Multi-modal dependency | Graceful degradation if vision model unavailable |
| R9 Theory of mind accuracy | Conservative predictions, human escalation |
| R10 Curriculum too rigid | Adaptive difficulty based on performance |
