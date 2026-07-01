# Tasks — Level-13 Expert Judge Swarm (G93-G95)

> **AUTONOMOUS BUILD**: All goals built in a single run without human-in-the-loop.
> Each goal has automated acceptance tests that must pass before the next goal starts.
> Human validation only at final ship gate (G96).

## Phase 1: Knowledge Source Adapters (G94)

- [ ] T94.1 Create `packages/server/src/services/knowledge-adapters/` directory
- [ ] T94.2 Implement `KnowledgeSourceAdapter` interface
- [ ] T94.3 Implement `WikipediaAdapter` (REST API, rate limit, error handling)
- [ ] T94.4 Implement `ArxivAdapter` (API, rate limit, error handling)
- [ ] T94.5 Implement `OkfAdapter` (lokale OKF, hergebruukt bestaande integratie)
- [ ] T94.6 Implement `DjimitKBAdapter` (MCP bridge, hergebruukt bestaande connectie)
- [ ] T94.7 Implement `knowledge_adapter_cache` tabel met TTL
- [ ] T94.8 Create test file with ≥ 12 tests covering: elke adapter, error handling, rate limiting, cache

Acceptance (G94): ALL tests pass. Elke adapter kan minimaal 1 bron doorzoeken.

## Phase 2: Judge Service (G95)

- [ ] T95.1 Create `packages/server/src/services/judge-service.ts`
- [ ] T95.2 Implement `evaluate(answers[])` met 4-dimension scoring
- [ ] T95.3 Implement evidence quality scoring (EvidenceService integratie)
- [ ] T95.4 Implement source reliability weighting
- [ ] T95.5 Implement logical consistency check (DAGConsensusService integratie)
- [ ] T95.6 Implement epistemic uncertainty penalty (EpistemicUncertaintyService integratie)
- [ ] T95.7 Implement contradiction detection
- [ ] T95.8 Implement verification status determination
- [ ] T95.9 Create test file with ≥ 12 tests covering: scoring, contradictions, edge cases

Acceptance (G95): ALL tests pass. Judge produceert consistente verdicts.

## Phase 3: Expert Swarm Orchestrator (G93)

- [ ] T93.1 Create `packages/server/src/services/expert-swarm-orchestrator.ts`
- [ ] T93.2 Implement `dispatch(topic, domains)` met parallelle sub-agents
- [ ] T93.3 Integreer NestedSpawnService voor sub-agent creation
- [ ] T93.4 Integreer SkillService voor skill acquisition
- [ ] T93.5 Implement timeout handling (60s per sub-agent)
- [ ] T93.6 Implement answer collection en aggregation
- [ ] T93.7 Integreer JudgeService voor verdict
- [ ] T93.8 Integreer KnowledgeRuntimeService voor graph update
- [ ] T93.9 Create `expert_swarm_history` tabel
- [ ] T93.10 Create test file with ≥ 12 tests covering: dispatch, parallel execution, timeout, result aggregation

Acceptance (G93): ALL tests pass. Minimaal 3 domains parallel uitvoerbaar.

## Phase 4: Integration (G96)

- [ ] T96.1 Voeg orchestrator toe aan server startup (index.ts)
- [ ] T96.2 Voeg REST endpoints toe (swarms.ts): POST /swarms/expert/dispatch
- [ ] T96.3 Voeg orchestrator toe aan autonomous cycle script
- [ ] T96.4 Run volledige test suite: `npm run test` → all green
- [ ] T96.5 Run type-check: `npm run type-check` → clean
- [ ] T96.6 Run lint: `npm run lint` → clean
- [ ] T96.7 Run production proof: `POST /api/proof-runs` → production_passed

Acceptance (G96): All automated tests green. Production proof green.

## Execution Order

```
G94 (Adapters) → G95 (Judge) → G93 (Orchestrator) → G96 (Integration)
```

G94 eerst omdat G95 adapters nodig heeft. G95 voor G93 omdat de orchestrator de judge nodig heeft.

## Validation Per Goal

After each goal:
1. Run: `npx vitest run __tests__/<goal>.test.ts`
2. ALL tests must pass
3. Fix failures (max 3 attempts)
4. Then proceed to next goal
