# Design — AGI Cognitive Evolution (Level-7)

## Execution Architecture

The entire change is built in **one autonomous run** by a single sub-agent (or
orchestrated sequence of sub-agents). Each goal is a coding task with:
1. Concrete file paths and function signatures
2. Automated acceptance tests
3. Clear integration points into existing code

No human approval is needed between goals. The sub-agent proceeds sequentially:
G35 → G36 → G37 → G38 → G39 → G40 → G41 → G42 → G43 → G44 → G45.

Between goals, the sub-agent runs the test suite. If tests fail, the sub-agent
fixes the code (up to 3 attempts) before proceeding. This is the same pattern
used in Level-5 and Level-6 builds.

## Cognitive Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                  DjimFlo Level-7 Cognitive Architecture               │
│                                                                       │
│  Metacognitive Layer (G35, G36, G37):                                │
│    Self-Model: calibration, known_unknowns, trends                   │
│    Experience Retrieval: past runs, similar objectives               │
│    Calibrated Selection: confidence-aware runtime routing            │
│                                                                       │
│  Epistemic Layer (G38, G39):                                         │
│    Epistemic Gates: source, consistency, coverage, falsifiability    │
│    Research Loop: DeerFlow executor, synthesis output                │
│                                                                       │
│  Autonomy Layer (G40, G41, G42):                                     │
│    Skill Distillation: trajectory → procedure → capability           │
│    Curiosity: gap detection → gap claims → investigation            │
│    Goal Formation: autonomous goal generation from gaps/patterns      │
│                                                                       │
│  Causal Layer (G43, G44):                                            │
│    Causal Inference: observational model, counterfactual queries      │
│    Self-Modification: draft contracts from recurring gaps            │
│                                                                       │
│  Integration: all layers connect to existing services via            │
│  well-defined seams (ContextInjection, LoopService, KnowledgeBus)    │
└─────────────────────────────────────────────────────────────────────┘
```

## G35 — Self-Model Service

### File: `packages/server/src/services/self-model-service.ts` (~350 LOC)

### Interface
```typescript
export interface SelfModel {
  version: number;
  lastUpdated: string;
  capabilityCalibration: Record<string, CapabilityCalibration>;
  knownUnknowns: KnownUnknown[];
}

export interface CapabilityCalibration {
  capabilityId: string;
  nRuns: number;
  observedSuccessRate: number;
  calibrationError: number;
  confidenceBins: ConfidenceBin[];
  recommendedConfidence: number;
  trend: 'improving' | 'stable' | 'degrading';
}

export class SelfModelService {
  constructor(private db: Database) {}

  calibrate(capabilityId: string): CapabilityCalibration
  getCalibration(capabilityId: string): CapabilityCalibration
  getKnownUnknowns(): KnownUnknown[]
  detectTrend(capabilityId: string): 'improving' | 'stable' | 'degrading'
  snapshot(): void
  getModel(): SelfModel
}
```

### Algorithm
1. Query `worker_leases WHERE capability_id = ?`
2. Success = status === 'completed' AND checker verdict accepted
3. Bin by predicted confidence (default 0.5) into 10 buckets
4. Per bucket: observed_accuracy = successes / total
5. Calibration_error = mean(|predicted - observed|) across bins with count ≥ 3
6. Platt scaling: logistic regression fit on (predicted → observed)
7. Trend: linear regression slope on last 10 outcomes

### Database
```sql
ALTER TABLE worker_leases ADD COLUMN confidence REAL DEFAULT 0.5;
CREATE TABLE IF NOT EXISTS self_model_snapshots (
  id TEXT PRIMARY KEY, model_json TEXT NOT NULL, calibration_error REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Integration
- `main()` (`index.ts`): start periodic calibration (every 30 min)
- `selectRuntime`: use calibrated confidence
- `missionControl`: expose calibration health

## G36 — Experience Retrieval Service

### File: `packages/server/src/services/experience-retrieval-service.ts` (~250 LOC)

### Interface
```typescript
export class ExperienceRetrievalService {
  constructor(private db: Database, private qdrantUrl: string) {}

  async indexRun(loopRunId: string): Promise<void>
  async retrieveRelevantRuns(objective: string, limit?: number): Promise<ExperienceResult[]>
  formatExperienceContext(results: ExperienceResult[]): string
}
```

### Algorithm
1. At loop run completion: embed objective + context via Qdrant fastembed
2. Store in `djimitflo_experience` collection + `experience_embeddings` table
3. At new goal start: similarity search, filter by outcome, return top-5
4. Format as context block for maker/checker prompt

### Database
```sql
CREATE TABLE IF NOT EXISTS experience_embeddings (
  run_id TEXT PRIMARY KEY, objective TEXT NOT NULL, outcome TEXT NOT NULL,
  retries INTEGER DEFAULT 0, runtime TEXT NOT NULL, capability_id TEXT,
  lessons TEXT, total_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Integration
- `ContextInjectionService.injectContext()`: 4th retrieval source
- `KnowledgeRuntimeService.closeLoop()`: trigger indexRun

## G37 — Calibrated Runtime Selection

### File: modify `packages/server/src/services/loop-service.ts` (extend `selectRuntime`)

### Algorithm
```
selectRuntimeForCapability(capabilityId, goalContext):
  calibration = selfModel.getCalibration(capabilityId)
  if calibration.nRuns < 3:
    return { runtime: getDefault(goalContext), confidence: calibration.recommendedConfidence }
  perRuntime = intelligence.measureCompetencePerRuntime(capabilityId)
  best = max(perRuntime, r => r.success_rate * calibration.recommendedConfidence)
  if best.success_rate < 0.3:
    return { runtime: best.runtime, confidence: 0.3, reason: 'all_below_threshold' }
  return { runtime: best.runtime, confidence: calibration.recommendedConfidence }
```

### Integration
- Replace `selectRuntime` call in `planLoopRun`
- Log selection reason in trace spans

## G38 — Epistemic Gates

### File: `packages/server/src/services/epistemic-gate-service.ts` (~300 LOC)

### Interface
```typescript
type EpistemicGateType = 'source_quality' | 'logical_consistency' | 'perspective_coverage' | 'falsifiability';

interface GateResult {
  name: EpistemicGateType;
  status: 'pass' | 'fail' | 'skipped';
  evidence: string;
  confidence: number;
}

export class EpistemicGateService {
  constructor(private db: Database) {}

  evaluateSourceQuality(evidenceRefs: string[]): GateResult
  evaluateLogicalConsistency(claimRefs: string[]): GateResult
  evaluatePerspectiveCoverage(panelIds: string[]): GateResult
  evaluateFalsifiability(deliverable: string, hypothesisIds: string[]): GateResult
  runAllGates(run: LoopRunRecord): GateResult[]
}
```

### Gate Logic
- **source_quality**: ≥ 2 sources, not all aged > 90 days
- **logical_consistency**: no contradicts edges (uses existing `evidenceGraphSummary`)
- **perspective_coverage**: ≥ 2 specialist types OR dissent present
- **falsifiability**: testable claim patterns OR hypothesis exists

### Integration
- `verifyLoopRun`: run after deterministic checks when `requiresEpistemicVerification`
- High/critical risk: gates are mandatory (block on fail)
- Low/medium risk: gates are advisory (logged)

## G39 — Research Loop

### File: modify `packages/server/src/services/loop-service.ts`

### Changes
1. Add `'research-loop'` to `LoopName` union
2. Add `discoverResearchQuestions()` method
3. Add DeerFlow executor to `buildRuntimeCommand`
4. Add research loop to `discoverLoopFindings` dispatch

### Discovery Function
```typescript
private discoverResearchQuestions(repoPath: string, max: number): LoopFinding[] {
  // Scan OKF for: confidence < 0.5 concepts > 30 days old
  // Scan claims for: unresolved capability_gap claims
  // Scan self-model for: known_unknowns
  // Convert each gap into a LoopFinding with type 'research_question'
}
```

### Executor
DeerFlow via existing `SkillService.acquire()` pipeline. Specialized prompt template
for search + synthesis + citation.

### Output
- OKF `memory/{topic-slug}.md` with frontmatter
- Claim ledger entries for key findings
- Follow-up work items for gaps

## G40 — Skill Distillation Service

### File: `packages/server/src/services/skill-distillation-service.ts` (~300 LOC)

### Interface
```typescript
export class SkillDistillationService {
  constructor(private db: Database, private okfSkillsDir: string) {}

  async distillFromRun(loopRunId: string): Promise<DistillationResult>
}
```

### Pipeline
1. Get successful maker trajectory (prompt + stdout + diff)
2. LLM distillation: "Extract reusable procedure"
3. Write to OKF `skills/{slug}.md`
4. Create capability_candidate
5. Auto-promote after 3 successes (existing `autoPromoteFromEvidence`)

### Integration
- `KnowledgeRuntimeService.closeLoop()`: trigger on improved runs

## G41 — Curiosity Service

### File: `packages/server/src/services/curiosity-service.ts` (~200 LOC)

### Interface
```typescript
export class CuriosityService {
  constructor(private db: Database, private intelligence: SwarmIntelligenceService) {}

  async scanForGaps(): Promise<GapReport>
  async publishGapClaims(gaps: Gap[]): Promise<void>
}
```

### Gap Detection
1. Domain coverage: OKF domains with < 3 concepts
2. Confidence: concepts with confidence < 0.5, > 30 days old
3. Contradictions: unresolved claim pairs > 7 days
4. Competence: self-model known_unknowns

### Integration
- `main()`: setInterval every 6 hours
- Publishes to KnowledgeBus → CapabilityAcquisitionService reacts

## G42 — Goal Formation Service

### File: `packages/server/src/services/goal-formation-service.ts` (~250 LOC)

### Interface
```typescript
export class GoalFormationService {
  constructor(private db: Database) {}

  async generateAutonomousGoals(): Promise<GoalRecord[]>
}
```

### Goal Sources
1. Curiosity gaps (max 2 per cycle)
2. Pattern detection (recurring failure modes)
3. Self-improvement (known_unknowns, max 1 per cycle)

### Capacity Budget
Max 50% of GOAL_MAX_CONCURRENT. Operator goals always preempt.

### Integration
- `LoopDaemon.tick()`: inject autonomous goals when capacity available

## G43 — Causal Inference Service

### File: `packages/server/src/services/causal-inference-service.ts` (~350 LOC)

### Interface
```typescript
export class CausalInferenceService {
  constructor(private db: Database) {}

  recordObservation(features: Record<string, string>, outcome: number): void
  predictIntervention(intervention: Record<string, string>): Prediction
  compareRuntimes(capabilityId: string, runtimeA: string, runtimeB: string): Comparison
}
```

### Algorithm
- Bayesian network from observational data
- Features: runtime, capability_type, goal_type, finding_count
- Outcome: success (1) or failure (0)
- Conditional probability tables updated per run
- Counterfactual: P(outcome | do(X), evidence=Y)

### Integration
- `LoopService.closeLoop()`: record observation
- `selectRuntime`: use causal predictions when evidence ≥ 10

## G44 — Adaptive Self-Modification

### File: extend `packages/server/src/services/meta-evolution-service.ts`

### Addition to `evaluate()`
```typescript
// After existing pruning/demotion:
const recurringGaps = this.db.prepare(`
  SELECT subject_ref, COUNT(*) as freq FROM swarm_claims
  WHERE predicate = 'capability_gap' AND created_at > datetime('now', '-30 days')
  GROUP BY subject_ref HAVING freq >= 3
`).all();

for (const gap of recurringGaps) {
  const draftContract = this.synthesizeContract(gap);
  this.intelligence.createCandidate({
    id: `loop-contract-${gap.subject_ref}`,
    kind: 'deterministic_harness',
    owner: 'meta-evolution',
    metadata: { draft_loop_contract: draftContract },
  });
}
```

### Safety
- Draft contracts: `live_route_allowed: false` (enforced by capability gate)
- Promotion requires: human approval + eval_score > 0.75 + 5 eval runs

## G45 — Ship Gate

### Full production proof with all G35-G44 active

```bash
npm run test           # all tests green (existing 92 + new 150+)
npm run type-check     # clean
npm run lint           # clean
npm run build          # clean
```

## Invariants (extended)

- **I27 Metacognitive**: recommended confidence tracks observed accuracy ±0.15 after 10+ runs
- **I28 Experience-grounded**: new goals retrieve ≥ 3 similar past runs when available
- **I29 Epistemic**: knowledge-work verified by ≥ 2 epistemic gates before completion
- **I30 Autonomous**: system generates ≥ 1 investigation goal per day when gaps exist
- **I31 Causal**: runtime selection uses causal predictions when evidence ≥ 10
- **I32 Self-modifying**: draft contracts synthesized but cannot route without approval

## Risks

- **R1 Calibration drift**: rolling window (30 days) mitigates
- **R2 Experience pollution**: filter by outcome='success' for procedures
- **R3 Epistemic false positives**: advisory for low-risk, mandatory only for high
- **R4 Curiosity runaway**: hard cap at 50% capacity
- **R5 Causal sparsity**: fall back to marginal probabilities when n < 5
- **R6 Distillation quality**: evidence-gated promotion (3 successes)
