# Tasks — Level-14 Scalable Expert Swarm (G97-G102)

> **AUTONOMOUS BUILD**: All goals built in a single run without human-in-the-loop.
> Human validation only at final ship gate (G102).

## G97: Skill-Driven Expert Workers

- [ ] T97.1 Injecteer SkillService in ExpertSwarmOrchestrator constructor
- [ ] T97.2 Update `executeExpert()` om skill procedure te injecteren in query
- [ ] T97.3 Voeg skill metadata toe aan ExpertAnswer
- [ ] T97.4 Update tests voor skill-driven behavior
- [ ] T97.5 Verify existing tests still pass

Acceptance: ExpertAnswer bevat skill metadata. Tests passen.

## G98: Worker Pool

- [ ] T98.1 Create `packages/server/src/services/worker-pool.ts`
- [ ] T98.2 Implement WorkerPool class met configurable concurrency
- [ ] T98.3 Implement queue-based work distribution
- [ ] T98.4 Implement automatic retry (max 2 retries)
- [ ] T98.5 Implement health monitoring (getStats)
- [ ] T98.6 Implement graceful shutdown
- [ ] T98.7 Create test file with ≥ 10 tests

Acceptance: 10 parallel workers draaien binnen 5s. Tests passen.

## G99: Judge Human-in-the-Loop

- [ ] T99.1 Voeg `getApprovalAction()` toe aan JudgeService
- [ ] T99.2 Implementeer score thresholds (≥80 auto, 60-79 review, <60 reject)
- [ ] T99.3 Integreer met OperatorInterventionService voor review queue
- [ ] T99.4 Voeg review status toe aan JudgeVerdict
- [ ] T99.5 Update tests voor approval logic
- [ ] T99.6 Create tests voor review flow

Acceptance: Score 85 → auto-approve. Score 70 → human review. Score 50 → rejected.

## G100: OKF Knowledge Graph Update

- [ ] T100.1 Create `packages/server/src/services/okf-knowledge-updater.ts`
- [ ] T100.2 Implementeer `updateFromVerdict()` voor automatische OKF updates
- [ ] T100.3 Implementeer `createConcept()` met frontmatter
- [ ] T100.4 Implementeer `updateConcept()` voor bestaande concepten
- [ ] T100.5 Implementeer `linkSources()` voor bron-verwijzingen
- [ ] T100.6 Create test file with ≥ 10 tests

Acceptance: Verified knowledge wordt automatisch als OKF concept opgeslagen.

## G101: Skill Evolution

- [ ] T101.1 Voeg `analyzeSkillPerformance()` toe aan SkillDistillationService
- [ ] T101.2 Implementeer skill improvement proposal generation
- [ ] T101.3 Implementeer skill frontmatter updates
- [ ] T101.4 Implementeer candidate → validated promotie
- [ ] T101.5 Create test file with ≥ 8 tests

Acceptance: Low-confidence results genereren skill improvement proposals.

## G102: Integration + Validation

- [ ] T102.1 Voeg WorkerPool + OkfUpdater toe aan server startup
- [ ] T102.2 Update REST API endpoints in swarms.ts
- [ ] T102.3 Voeg expert swarm toe aan autonomous cycle
- [ ] T102.4 Run full test suite: `npm run test` → all green
- [ ] T102.5 Run type-check: `npm run type-check` → clean
- [ ] T102.6 Run lint: `npm run lint` → clean
- [ ] T102.7 Run production proof met expert swarm
- [ ] T102.8 Write closure.md with evidence

Acceptance: All automated tests green. Production proof green.

## Execution Order

```
G97 → G98 → G99 → G100 → G101 → G102
```

Between each goal: run test suite. Fix failures (max 3 attempts). Then proceed.
