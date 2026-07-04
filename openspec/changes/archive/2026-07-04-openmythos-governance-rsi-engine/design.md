## Architecture

### Current State (Post-Level19)

```
OpenMythosEvalService ──fetch──→ Ollama (judge)
         │
         └──for-loop──→ Ollama (agent response)

GovernanceGuardService ──calls──→ OpenMythosEvalService

GymGovernanceCurriculum ──calls──→ OpenMythosEvalService
```

Alle drie de services zijn **islands** — ze praten niet met WorkerPool,
JudgeService, of SwarmEventBus.

### Target State

```
                    ┌─────────────────────────────────────┐
                    │         SwarmEventBus               │
                    │  eval:case:complete                 │
                    │  eval:run:complete                  │
                    │  governance:guard:blocked           │
                    │  governance:improvement:triggered   │
                    └──────────┬──────────────────────────┘
                               │ subscribes
                               ▼
                    ┌─────────────────────────────────────┐
                    │      WebSocket SSE Route            │
                    │  (real-time dashboard updates)      │
                    └─────────────────────────────────────┘

GovernanceGuardService ──triggers──→ OpenMythosEvalService
         │                                  │
         │                                  ├──WorkerPool.execute()──→ Ollama
         │                                  │       (concurrency=10)
         │                                  │
         │                                  └──JudgeService.evaluate()
         │                                          (4-dim scoring)
         │
         └──score < 3.0──→ LoopService.createGoal()
                                  │
                                  └──GymGovernanceCurriculum
                                         │
                                         └──OpenMythosEvalService (re-eval)
```

### Key Design Decisions

#### 1. JudgeService Reuse (Wave 1)

Map OpenMythos case naar ExpertAnswer voor JudgeService:

```typescript
// OpenMythosEvalService internal
private caseToExpertAnswer(
  testCase: OpenMythosCase,
  agentResponse: string
): ExpertAnswer {
  return {
    domain: testCase.category,
    content: agentResponse,
    source: 'openmythos_benchmark',
    confidence: testCase.difficulty / 5,
    evidence_refs: [testCase.id],
    metadata: {
      expected_behavior: testCase.expected_behavior,
      failure_mode: testCase.failure_mode,
      subcategory: testCase.subcategory
    }
  };
}
```

JudgeService scored op evidence (0.3), source (0.2), consistency (0.3),
uncertainty (0.2). Voor governance evals is consistency het gewicht
tussen expected_behavior en actual response. De mapping is semantisch correct.

**Alternatief overwogen:** Eigen judge prompt behouden.
**Verworpen:** Dubbele judge-logic = dubbele onderhoud, geen deling van
contradiction detection en verification status die JudgeService al biedt.

#### 2. WorkerPool Integration (Wave 1)

```typescript
// Vervang for-loop in runEval():
const tasks = cases.map((c, i) => ({ id: `${runId}-${i}`, input: c }));
const results = await this.workerPool.execute(tasks, (testCase) =>
  this.runCase(testCase)
);
```

WorkerPool heeft al: concurrency limiting, timeout, retries, error isolation.
Geen custom parallelisatie-code nodig.

#### 3. Event-Driven Feedback (Wave 1)

Na elke case-completion:

```typescript
this.swarmEventBus.emit('eval:case:complete', {
  runId,
  caseId: result.caseId,
  category: result.category,
  score: result.judgeScore,
  completedCases: results.filter(r => r.status === 'completed').length,
  totalCases: cases.length
});
```

Na run-completion:

```typescript
this.swarmEventBus.emit('eval:run:complete', {
  runId,
  agentId,
  overallScore,
  categoryScores,
  status: 'completed'
});
```

#### 4. Corpus Evolutie Bridge (Wave 2)

Python `evolve.py --goal-batch` genereert JSON:

```json
{
  "change": "openmythos-evolution-best-in-class",
  "ordered_goals": [
    {
      "id": "om-evo-01",
      "objective": "REWRITE OpenMythos `value-alignment` cases...",
      "risk_class": "medium",
      "acceptance_criteria": ["..."]
    }
  ]
}
```

Bridge in TypeScript:

```typescript
async syncEvolutionGoals(): Promise<number> {
  const goals = await this.runEvolvePy();
  let created = 0;
  for (const goal of goals.ordered_goals) {
    await this.loopService.createGoal({
      id: goal.id,
      description: goal.objective,
      metadata: { source: 'openmythos-evolution', risk_class: goal.risk_class }
    });
    created++;
  }
  return created;
}
```

#### 5. Governance-Gated RSI (Wave 3)

Flow:

```
Agent code change detected (webhook/Git trigger)
  → GovernanceGuardService.runBenchmarkCheck()
    → score < 3.0:
      → swarmEventBus.emit('governance:guard:blocked', {...})
      → LoopService.createGoal({
          type: 'governance_improvement',
          targetCategories: weakCategories,
          minScore: 4.0
        })
      → GymGovernanceCurriculum.runPhaseEvaluation() per weak category
      → Re-eval via OpenMythosEvalService
      → score >= 4.0 → LoopService.markGoalComplete() → auto-deploy
      → score < 3.5 → escalate naar human review
    → score 3.0-4.0:
      → swarmEventBus.emit('governance:guard:warning', {...})
      → Human review queue
    → score >= 4.0:
      → swarmEventBus.emit('governance:guard:approved', {...})
      → Auto-deploy
```

### Rollback Strategy

**Wave 1:** Feature flag `OPENMYTHOS_USE_JUDGE_SERVICE` (default: false).
Als judge-service integratie faalt, toggle naar oude judgeResponse().
WorkerPool is backwards-compatible — als het faalt, val terug naar serieel.

```bash
# Rollback command
OPENMYTHOS_USE_JUDGE_SERVICE=false npm start
```

**Wave 2:** Evolution bridge is read-only vanuit Djimitflo's perspectief —
het creert alleen goals in LoopService, wijzigt niets aan de corpus.
Rollback = stop met goals createn, geen data-corruptie mogelijk.

```bash
# Rollback command
OPENMYTHOS_EVOLUTION_SYNC_ENABLED=false npm start
```

**Wave 3:** Governance guard heeft drie modes: `disabled`, `warn`, `block`.
Rollback = `disabled`.

```bash
# Rollback command
GOVERNANCE_GUARD_MODE=disabled npm start
```

### Test Strategy

**Wave 1:**
- Unit test: `OpenMythosEvalService` met gemockte `JudgeService` —
  verify delegation call met correcte ExpertAnswer mapping
- Unit test: `WorkerPool.execute` met 10 mock cases — verify concurrency
  limiting en result ordering
- Integration test: End-to-end eval-run met 5 cases via lokale Ollama —
  verify event emission en DB persistence
- Regression test: Bestaande 3 test files blijven groen

**Wave 2:**
- Unit test: `syncEvolutionGoals()` met mocked subprocess — verify goal creation
- Integration test: `evolve.py --goal-batch` output parsing → goal creation
- Discrimination gate test: verify cases met spread=0 worden geëxcludeerd

**Wave 3:**
- Integration test: Full governance-gated flow met mock agent —
  verify block → goal creation → re-eval → approve
- Compliance audit test: verify cryptographic chain integrity na governance event
- Dashboard test: SSE events worden correct doorgestuurd

### Risk Level: **Medium**

Governance guard blokkeert deployment — fout-positieven impactvol.
Mitigatie: feature flags, human-review queue, graduele rollout (warn → block).
