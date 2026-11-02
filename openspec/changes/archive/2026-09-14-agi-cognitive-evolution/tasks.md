# Tasks — AGI Cognitive Evolution (Level-7)

> **AUTONOMOUS BUILD**: All goals G35-G44 are built in a single run without
> human-in-the-loop. Each goal has automated acceptance tests that must pass
> before the next goal starts. The only human interaction is at G45 (ship gate).
>
> Pattern: consistent with Level-5 (G19-G27) and Level-6 (G28-G34) builds.

## G35 — Self-Model Service

- [x] T35.1 Create `packages/server/src/services/self-model-service.ts` with:
        - `SelfModelService` class constructor(db: Database)
        - `calibrate(capabilityId)` implementing Platt scaling
        - `getKnownUnknowns()` returning domains with calibration_error > 0.2
        - `detectTrend(capabilityId)` with linear regression on last 10 outcomes
        - `snapshot()` persisting to `self_model_snapshots` table
        - `getModel()` returning full SelfModel
- [x] T35.2 Add migration: `ALTER TABLE worker_leases ADD COLUMN confidence REAL DEFAULT 0.5`
- [x] T35.3 Create `self_model_snapshots` table
- [x] T35.4 Wire periodic calibration in `main()` (every 30 min via setInterval)
- [x] T35.5 Create test file `packages/server/src/__tests__/self-model-service.test.ts`
        with ≥ 15 tests covering: calibration accuracy, known unknowns detection,
        trend detection, snapshot persistence, graceful handling of no data

Acceptance (G35): ALL tests in `self-model-service.test.ts` pass.
After 10 runs (8 success, 2 fail) with confidence 0.8: calibration_error < 0.15.
After 3 runs: recommended_confidence < 0.5.

## G36 — Experience Retrieval

- [ ] T36.1 Create `packages/server/src/services/experience-retrieval-service.ts` with:
        - `ExperienceRetrievalService` class constructor(db, qdrantUrl)
        - `indexRun(loopRunId)` embedding objective + storing in Qdrant + DB
        - `retrieveRelevantRuns(objective, limit=5)` similarity search
        - `formatExperienceContext(results)` → context block string
- [ ] T36.2 Create `experience_embeddings` table
- [ ] T36.3 Integrate into `ContextInjectionService.injectContext()` as 4th source
- [ ] T36.4 Trigger `indexRun` at loop run completion (best-effort, non-blocking)
- [ ] T36.5 Create test file `packages/server/src/__tests__/experience-retrieval.test.ts`
        with ≥ 15 tests covering: indexing, retrieval similarity, context formatting,
        graceful degradation with no data, Qdrant unavailability fallback

Acceptance (G36): ALL tests pass. Identical objectives: similarity > 0.9.
Related objectives: similarity > 0.6. Lessons appear in maker context when ≥ 3 past runs.

## G37 — Calibrated Runtime Selection

- [ ] T37.1 Implement `selectRuntimeForCapability(capabilityId, goalContext)` in
        `loop-service.ts` using SelfModel calibration + per-runtime competence
- [ ] T37.2 Fallback to default heuristic when nRuns < 3
- [ ] T37.3 Skip runtimes with success_rate < 0.3 unless no alternative
- [ ] T37.4 Replace `selectRuntime` call in `planLoopRun` with calibrated variant
- [ ] T37.5 Log selection reason in trace spans
- [ ] T37.6 Create test file `packages/server/src/__tests__/calibrated-selection.test.ts`
        with ≥ 10 tests covering: sufficient data selection, insufficient data fallback,
        all-below-threshold handling, reason logging

Acceptance (G37): ALL tests pass. With n ≥ 5: selects best calibrated runtime.
With n < 3: uses default + low confidence. Never selects runtime with sr < 0.3
unless no alternative.

## G38 — Epistemic Gates

- [ ] T38.1 Create `packages/server/src/services/epistemic-gate-service.ts` with:
        - `EpistemicGateService` class constructor(db)
        - `evaluateSourceQuality(evidenceRefs)` — ≥ 2 sources, not all aged
        - `evaluateLogicalConsistency(claimRefs)` — no contradicts edges
        - `evaluatePerspectiveCoverage(panelIds)` — ≥ 2 types OR dissent
        - `evaluateFalsifiability(deliverable, hypothesisIds)` — testable claims
        - `runAllGates(run)` — runs all gates, returns GateResult[]
- [ ] T38.2 Integrate into `verifyLoopRun` — runs when `requiresEpistemicVerification`
- [ ] T38.3 For high/critical risk: gates are mandatory (block on fail)
- [ ] T38.4 For low/medium risk: gates are advisory (logged, not blocking)
- [ ] T38.5 Create test file `packages/server/src/__tests__/epistemic-gates.test.ts`
        with ≥ 20 tests covering: each gate pass/fail, mandatory vs advisory,
        integration with verifyLoopRun

Acceptance (G38): ALL tests pass. source_quality: 0 sources → fail, 2 sources
different domains → pass. logical_consistency: contradicts edge → fail.
perspective_coverage: 1 type → fail, 2 types + dissent → pass.
falsifiability: "improved performance" → pass, "made it better" → fail.

## G39 — Research Loop

- [ ] T39.1 Add `'research-loop'` to `LoopName` union in `loop-service.ts:18`
- [ ] T39.2 Add research loop contract constant (trigger, context, actions, verification)
- [ ] T39.3 Implement `discoverResearchQuestions(repoPath, max)` scanning OKF for gaps
- [ ] T39.4 Add DeerFlow executor to `buildRuntimeCommand` with research prompt template
- [ ] T39.5 Research loop output → OKF `memory/{topic-slug}.md` with frontmatter
- [ ] T39.6 Research loop output → claim ledger entries for key findings
- [ ] T39.7 Wire into `discoverLoopFindings` dispatch
- [ ] T39.8 Create test file `packages/server/src/__tests__/research-loop.test.ts`
        with ≥ 15 tests covering: discovery, execution, output format, OKF write,
        claim creation, epistemic gate integration

Acceptance (T39): ALL tests pass. Research loop produces synthesis with ≥ 3 cited
sources. All epistemic gates pass. Findings written to OKF memory store.

## G40 — Skill Distillation

- [ ] T40.1 Create `packages/server/src/services/skill-distillation-service.ts` with:
        - `SkillDistillationService` class constructor(db, okfSkillsDir)
        - `distillFromRun(loopRunId)` → extracts trajectory, LLM distillation, writes OKF
- [ ] T40.2 Integrate into `KnowledgeRuntimeService.closeLoop()` — triggers on improved runs
- [ ] T40.3 Distilled procedures create capability_candidate with source metadata
- [ ] T40.4 Auto-promote after 3 successes (reuses `autoPromoteFromEvidence`)
- [ ] T40.5 Create test file `packages/server/src/__tests__/skill-distillation.test.ts`
        with ≥ 15 tests covering: distillation, OKF write, candidate creation,
        auto-promotion, graceful handling of missing trajectory

Acceptance (G40): ALL tests pass. After 5 successful maker runs with same finding
type: ≥ 1 distilled procedure. Procedure retrievable via getSkillForFinding.

## G41 — Curiosity Service

- [ ] T41.1 Create `packages/server/src/services/curiosity-service.ts` with:
        - `CuriosityService` class constructor(db, intelligence)
        - `scanForGaps()` → GapReport (coverage, confidence, contradiction, competence)
        - `publishGapClaims(gaps)` → publishes to KnowledgeBus
- [ ] T41.2 Wire periodic scan in `main()` (every 6 hours)
- [ ] T41.3 Create test file `packages/server/src/__tests__/curiosity-service.test.ts`
        with ≥ 15 tests covering: coverage gaps, confidence gaps, contradiction gaps,
        competence gaps, claim publishing

Acceptance (G41): ALL tests pass. Empty OKF → ≥ 1 coverage gap. Concept with
confidence 0.3, 60 days old → confidence gap. Gap claims published to KnowledgeBus.

## G42 — Goal Formation

- [ ] T42.1 Create `packages/server/src/services/goal-formation-service.ts` with:
        - `GoalFormationService` class constructor(db)
        - `generateAutonomousGoals()` → GoalRecord[] from gaps, patterns, self-model
- [ ] T42.2 Enforce 50% capacity cap for autonomous goals
- [ ] T42.3 Wire into `LoopDaemon.tick()` — inject when capacity available
- [ ] T42.4 All autonomous goals have explicit acceptance criteria + metadata
- [ ] T42.5 Create test file `packages/server/src/__tests__/goal-formation.test.ts`
        with ≥ 15 tests covering: curiosity goals, pattern goals, self-improvement
        goals, capacity cap, operator preemption

Acceptance (G42): ALL tests pass. Information gaps exist → ≥ 1 autonomous goal.
Autonomous goals never exceed 50% capacity. Operator goals always preempt.

## G43 — Causal Inference

- [ ] T43.1 Create `packages/server/src/services/causal-inference-service.ts` with:
        - `CausalInferenceService` class constructor(db)
        - `recordObservation(features, outcome)` — update probability tables
        - `predictIntervention(intervention)` → Prediction
        - `compareRuntimes(capabilityId, runtimeA, runtimeB)` → Comparison
- [ ] T43.2 Integrate into `LoopService.closeLoop()` — record observation
- [ ] T43.3 Integrate into `selectRuntime` when evidence ≥ 10
- [ ] T43.4 Create test file `packages/server/src/__tests__/causal-inference.test.ts`
        with ≥ 15 tests covering: observation recording, prediction accuracy,
        counterfactual queries, runtime comparison, sparse data fallback

Acceptance (G43): ALL tests pass. After 20+ runs: predictions > 60% accuracy.
What-if queries return prediction + confidence + evidence count.

## G44 — Adaptive Self-Modification

- [ ] T44.1 Extend `MetaEvolutionService.evaluate()` with synthesis step
- [ ] T44.2 Query recurring capability_gap claims (≥ 30 days, ≥ 3 occurrences)
- [ ] T44.3 Generate draft loop contracts from recurring gaps
- [ ] T44.4 Create draft capabilities with `live_route_allowed: false`
- [ ] T44.5 Promotion to candidate requires human approval + eval_score > 0.75
- [ ] T44.6 Create test file `packages/server/src/__tests__/adaptive-self-modification.test.ts`
        with ≥ 10 tests covering: gap detection, contract synthesis, draft creation,
        promotion safety

Acceptance (G44): ALL tests pass. 3+ gaps → draft contract. Draft cannot route
without human approval. Promotion requires human + eval_score > 0.75.

## G45 — Ship Gate (final, human validation)

- [ ] T45.1 Run full test suite: `npm run test` → all green
- [ ] T45.2 Run type-check: `npm run type-check` → clean
- [ ] T45.3 Run lint: `npm run lint` → clean
- [ ] T45.4 Run build: `npm run build` → clean
- [ ] T45.5 Run production proof: `POST /api/proof-runs` with research-loop finding
- [ ] T45.6 Validate all G35-G44 acceptance criteria in production
- [ ] T45.7 Write `closure.md` with evidence
- [ ] T45.8 Commit with message referencing all goals G35-G44

Acceptance (G45): Production proof green. All automated tests green. Human operator
validates the final ship evidence.

## Execution Order (sequential, autonomous)

```
G35 (Self-Model) → G36 (Experience) → G37 (Calibrated Selection)
                 ↓
G38 (Epistemic Gates) → G39 (Research Loop)
                 ↓
G40 (Distillation) → G41 (Curiosity) → G42 (Goal Formation)
                 ↓
G43 (Causal) → G44 (Self-Modification) → G45 (Ship)
```

Between each goal: run test suite. Fix failures (max 3 attempts). Then proceed.
