# Tasks — Level-8 Complete (G44p-G63, 21 goals)

> **AUTONOMOUS BUILD**: All goals built in a single run without human-in-the-loop.
> Each goal has automated acceptance tests that must pass before the next goal starts.
> Human validation only at final ship gate (G63).

## Phase 0: Production Proof + Test Fixes (G44p)

- [ ] T44p.1 Fix runtime-security.test.ts — update to check new `--sandbox workspace-write` + `approval_policy=never` flags
- [ ] T44p.2 Fix runtime-semaphore.test.ts — add `sem.dynamicLimit = null` to `resetSemaphore()`
- [ ] T44p.3 Fix g16-continuous-operation.test.ts — accept `goal_completed` event in addition to `goal_started`
- [ ] T44p.4 Fix g19-parallel-goals.test.ts (x3) — accept `goal_completed` + check `started + completed` count
- [ ] T44p.5 Run production proof with all G35-G44 services active
- [ ] T44p.6 Validate all 596 existing tests green

Acceptance (G44p): ALL 596 tests green. Production proof `production_passed: true`.

## Phase 1: Best-of-Breed (G45-G56)

### G45 — Thompson Sampling Bandit
- [ ] T45.1 Create `thompson-bandit-service.ts` with Beta distribution per (capability, runtime)
- [ ] T45.2 Create `thompson_bandits` table
- [ ] T45.3 Implement `selectArm()` with Thompson Sampling
- [ ] T45.4 Implement `recordOutcome()` with decay
- [ ] T45.5 Integrate into `loop-service.ts` (use when n >= 5, fallback otherwise)
- [ ] T45.6 Create test file with >= 15 tests

Acceptance: Converges to best runtime within 20 trials in >= 80% of simulations.

### G46 — Search Feedback Loop
- [ ] T46.1 Create `search_feedback` table
- [ ] T46.2 Extend ContextInjectionService with `recordFeedback()`
- [ ] T46.3 Extend ExperienceRetrievalService with feedback-weighted ranking
- [ ] T46.4 Create TTL pruning job (90 days)
- [ ] T46.5 Create test file with >= 15 tests

Acceptance: MRR improves >= 10% after 50 feedback cycles.

### G47 — GOAP A* Planner
- [ ] T47.1 Create `goap-planner-service.ts` with A* search
- [ ] T47.2 Create `goap_actions` table with precondition/effect models
- [ ] T47.3 Implement `plan()` and `replan()` methods
- [ ] T47.4 Integrate into LoopService for multi-step goals
- [ ] T47.5 Create test file with >= 20 tests

Acceptance: Optimal path in >= 90% of solvable cases. Replanning works on failure.

### G48 — Metacognitive Planner
- [ ] T48.1 Create `metacognitive-planner.ts` with ROI-based gap prioritization
- [ ] T48.2 Implement `estimateImpact()` and `estimateEffort()`
- [ ] T48.3 Integrate with Self-Model (G35) and Goal Formation (G42)
- [ ] T48.4 Create weekly scheduler
- [ ] T48.5 Create test file with >= 15 tests

Acceptance: Generates >= 1 learning goal per week when gaps exist.

### G49 — DAG Consensus
- [ ] T49.1 Create `dag-consensus-service.ts` with weighted voting
- [ ] T49.2 Extend evidence edges with confidence weights
- [ ] T49.3 Integrate with ClaimLedger post-loop-run
- [ ] T49.4 Create test file with >= 15 tests

Acceptance: Tolerates < 1/3 malicious nodes. Resolves correctly with clear majority.

### G50 — Federation Protocol
- [ ] T50.1 Create `federation-service.ts` with mTLS + signing
- [ ] T50.2 Create `federation_peers` and `federation_messages` tables
- [ ] T50.3 Implement PII stripping (14-type detection)
- [ ] T50.4 Implement trust scoring
- [ ] T50.5 Create REST endpoints
- [ ] T50.6 Create test file with >= 15 tests

Acceptance: 0 PII leaks. Trust scoring matches formula. Untrusted messages rejected.

### G51 — Plugin Marketplace
- [ ] T51.1 Create `plugin-registry-service.ts` with install/unload/verify
- [ ] T51.2 Extend `swarm_capabilities` with plugin metadata
- [ ] T51.3 Create REST API for plugin management
- [ ] T51.4 Create test file with >= 15 tests

Acceptance: Hot-swap < 1s. Signature verification rejects invalid. Dependencies resolve.

### G52 — MetaHarness Self-Audit
- [ ] T52.1 Create `meta-harness-service.ts` with 6-dimension grading
- [ ] T52.2 Create `meta_harness_reports` table
- [ ] T52.3 Implement config validation + security scanning
- [ ] T52.4 Create REST endpoint + CLI command
- [ ] T52.5 Create test file with >= 15 tests

Acceptance: Grade covers 6 dimensions. Regression detection catches injected changes.

### G53 — Cognitive Memory Patterns
- [ ] T53.1 Create `cognitive-memory-service.ts` with skill library + causal edges
- [ ] T53.2 Create `skill_library` and `causal_edges` tables
- [ ] T53.3 Integrate skills into ContextInjectionService
- [ ] T53.4 Create test file with >= 15 tests

Acceptance: Skill retrieval > 0.7 similarity. Causal explanations generated.

### G54 — Elastic Memory
- [ ] T54.1 Create `elastic-memory-service.ts` with load measurement
- [ ] T54.2 Implement scale up/down based on query rates
- [ ] T54.3 Create hourly scheduler
- [ ] T54.4 Create test file with >= 15 tests

Acceptance: Scales on load. Cold compression works. No flapping.

### G55 — Influence Attribution
- [ ] T55.1 Create `influence-attribution-service.ts` with Shapley values
- [ ] T55.2 Create `influence_attribution` table
- [ ] T55.3 Integrate with loop completion + Thompson bandit
- [ ] T55.4 Create test file with >= 15 tests

Acceptance: Influence sums to 1.0. Shapley fairness holds.

### G56 — Competence Awareness
- [ ] T55.1 Create `competence-awareness-service.ts` with novelty detection
- [ ] T56.2 Implement embedding-distance novelty assessment
- [ ] T56.3 Integrate into LoopService pre-processing
- [ ] T56.4 Create test file with >= 15 tests

Acceptance: Novel situations detected. Conservative mode triggered on low competence.

## Phase 2: Architecture Evolution (G57-G60)

### G57 — Skill Marketplace
- [ ] T57.1 Create `skill-marketplace-service.ts` with publish/search/install/rate
- [ ] T57.2 Create `skill_shares` table
- [ ] T57.3 Integrate with G40 Skill Distillation
- [ ] T57.4 Create REST API
- [ ] T57.5 Create test file with >= 15 tests

### G58 — Operator Intervention
- [ ] T58.1 Extend `operator-intervention.ts` with request/approve/reject
- [ ] T58.2 Create `intervention_requests` table
- [ ] T58.3 Integrate with G56 Competence Awareness
- [ ] T58.4 Create REST API
- [ ] T58.5 Create test file with >= 15 tests

### G59 — Multi-Modal Perception
- [ ] T59.1 Create `multi-modal-perception-service.ts` with screenshot/diagram/OCR
- [ ] T59.2 Integrate with vision model
- [ ] T59.3 Create `perception_results` table
- [ ] T59.4 Create test file with >= 15 tests

### G60 — Control Loop Self-Modification
- [ ] T60.1 Create `control-loop-self-modification-service.ts` with propose/eval/apply/rollback
- [ ] T60.2 Create `contract_proposals` table
- [ ] T60.3 Implement safety gates (draft → eval → human → apply)
- [ ] T60.4 Create test file with >= 15 tests

## Phase 3: AGI Foundations (G61-G62)

### G61 — Theory of Mind
- [ ] T61.1 Create `theory-of-mind-service.ts` with intent modeling
- [ ] T61.2 Create `agent_intent_models` table
- [ ] T61.3 Integrate with G55 Influence Attribution
- [ ] T61.4 Create test file with >= 15 tests

### G62 — Curriculum Learning
- [ ] T62.1 Create `curriculum-learning-service.ts` with step generation
- [ ] T62.2 Create `curriculum_steps` table
- [ ] T62.3 Integrate with G48 Metacognitive Planner
- [ ] T62.4 Create test file with >= 15 tests

## Ship (G63)

- [ ] T63.1 Run full test suite: `npm run test` → all green (596 existing + 200+ new)
- [ ] T63.2 Run type-check: `npm run type-check` → clean
- [ ] T63.3 Run lint: `npm run lint` → clean
- [ ] T63.4 Run production proof with ALL services active
- [ ] T63.5 Validate all acceptance criteria
- [ ] T63.6 Write closure.md with evidence
- [ ] T63.7 Commit and push

Acceptance (G63): All automated tests green. Human operator validates final ship.

## Execution Order

```
G44p (Fixes + Proof)
  ↓
G45 → G46 → G47 → G48 → G49 → G50 → G51 → G52 → G53 → G54 → G55 → G56
  ↓
G57 → G58 → G59 → G60
  ↓
G61 → G62
  ↓
G63 (Ship)
```

Between each goal: run test suite. Fix failures (max 3 attempts). Then proceed.
