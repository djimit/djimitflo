# Implementation Tasks

## Wave 1: Refactor naar Bestaande Infra

### Task 1.1: JudgeService Integration
**Files:** `packages/server/src/services/openmythos-eval-service.ts`
- [x] Voeg `JudgeService` dependency toe via constructor injection
- [x] Implementeer `caseToExpertAnswer()` private method
- [x] Vervang `judgeResponse()` (regel 202-245) met `JudgeService.evaluate()` call
- [x] Map `JudgeVerdict.score` (0-100) terug naar 1-5 scale
- [x] Behoud backwards-compat via `OPENMYTHOS_USE_JUDGE_SERVICE` env flag
- [x] Update unit test `openmythos-eval-service.test.ts` voor nieuwe judge path

**Validation:** `npm test -- --filter openmythos-eval-service` — alle tests groen
**Rollback:** `OPENMYTHOS_USE_JUDGE_SERVICE=false`

### Task 1.2: WorkerPool Parallelisatie
**Files:** `packages/server/src/services/openmythos-eval-service.ts`
- [x] Voeg `WorkerPool` dependency toe (instantieer met concurrency=10, timeout=120s)
- [x] Vervang serieel `for (const testCase of cases)` (regel 103-123) met `WorkerPool.execute()`
- [x] Transformeer cases naar `WorkerTaskInput<OpenMythosCase>[]`
- [x] Verzamel results als `WorkerTaskResult<OpenMythosCase, CaseResult>[]`
- [x] Handle failed tasks (niet-crash, markeer als `status: 'failed'`)

**Validation:** Eval-run van 50 cases voltooit in < 60s (vs >25s serieel)
**Rollback:** Vervang WorkerPool.execute terug met for-loop

### Task 1.3: SwarmEventBus Integration
**Files:** `packages/server/src/services/openmythos-eval-service.ts`, `packages/server/src/services/swarm-event-bus.ts`
- [x] Import `swarmEventBus` singleton in eval service
- [x] Emit `eval:case:complete` na elke case (binnen WorkerPool callback)
- [x] Emit `eval:run:complete` na run-completion
- [x] Voeg event types toe aan `SwarmEventType` union in `swarm-event-bus.ts`:
  `eval:case:complete`, `eval:run:complete`, `governance:guard:blocked`,
  `governance:guard:warning`, `governance:guard:approved`,
  `governance:improvement:triggered`
- [x] Subscribe SSE route op eval events voor real-time dashboard

**Validation:** SSE client ontvangt events tijdens eval-run
**Rollback:** Verwijder emit calls (geen side-effects op SSE clients)

### Task 1.4: GovernanceGuardService Category Mapping Fix
**Files:** `packages/server/src/services/governance-guard-service.ts`
- [x] Vervang substring matching (`t.includes('file_write')`) met structured tool taxonomy
- [x] Implementeer `ToolRiskClassifier` met expliciete mapping:
  - `file_write`, `file_edit`, `file_delete` → `tool-scope`
  - `exec`, `shell`, `bash` → `tool-scope` + `hierarchy`
  - `http_request`, `api_call`, `webhook` → `injection` + `cross-lingual`
  - `database_query`, `database_write` → `tool-scope` + `contradiction`
- [x] Maak mapping configurable via `GOVERNANCE_TOOL_TAXONOMY` env (JSON)
- [x] Unit test voor elke tool → category mapping

**Validation:** `npm test -- --filter governance-guard` — alle tests groen
**Rollback:** `GOVERNANCE_TOOL_TAXONOMY` unset → val terug naar bestaande substring matching

---

## Wave 2: Data-Driven Corpus Evolutie

### Task 2.1: Evolution Bridge Service
**Files:** `packages/server/src/services/openmythos-evolution-bridge.ts` (nieuw)
- [x] Implementeer `runEvolvePy()` — subprocess call naar Python evolve.py
- [x] Parse `--goal-batch` JSON output
- [x] Map evolution goals naar Djimitflo `LoopService.createGoal()` format
- [x] Voeg rate limiting toe (max 1 sync per 24h)
- [x] Feature flag: `OPENMYTHOS_EVOLUTION_SYNC_ENABLED`

**Validation:** Bridge run met test corpus → goals gemaakt in LoopService
**Rollback:** `OPENMYTHOS_EVOLUTION_SYNC_ENABLED=false`

### Task 2.2: Discrimination Gate
**Files:** `packages/server/src/services/openmythos-eval-service.ts`
- [x] Implementeer `filterDiscriminatingCases()` — excludeer cases met spread=0
  uit laatste N runs
- [x] Query `openmythos_case_results` voor per-case score variance
- [x] Alleen cases met `STDDEV(score) > 0` over laatste 3 runs meenemen
- [x] Log excluded cases voor audit trail

**Validation:** Eval-run na discrimination gate bevat < 230 cases (vs 275)
**Rollback:** `OPENMYTHOS_DISCRIMINATION_GATE_ENABLED=false`

### Task 2.3: Curriculum Data Refresh
**Files:** `packages/server/src/services/gym-governance-curriculum.ts`
- [x] Verwijder `value-alignment` uit Phase 4 (100% dead)
- [x] Vervang met `cross-lingual` + `temporal-reasoning` (hoge discrimination)
- [x] Implementeer `refreshCurriculum()` — haal category statistics uit
  `openmythos_case_results` en pas fasen-grenzen aan
- [x] Minimaal 1 category per fase met avg_spread >= 1.0

**Validation:** `npm test -- --filter gym-governance-curriculum` — tests groen met nieuwe fasen
**Rollback:** Hardcode oude CURRICULUM_PHASES constant

---

## Wave 3: Governance-Gated RSI Pipeline

### Task 3.1: Deploy Hook Integration
**Files:** `packages/server/src/services/governance-guard-service.ts`
- [x] Voeg `triggeredBy` parameter toe aan `runBenchmarkCheck()`
  (`'deploy' | 'manual' | 'schedule'`)
- [x] Bij `triggeredBy: 'deploy'` + score < 3.0 → emit `governance:guard:blocked`
- [x] Bij `triggeredBy: 'deploy'` + score 3.0-4.0 → emit `governance:guard:warning`
- [x] Voeg `complianceAuditService.logGovernanceCheck()` call toe na elke check

**Validation:** Deploy hook test → correcte events + audit log entry
**Rollback:** `GOVERNANCE_GUARD_MODE=disabled`

### Task 3.2: Auto-Improvement Goal Creation
**Files:** `packages/server/src/services/governance-improvement-service.ts` (nieuw)
- [x] Subscribe op `governance:guard:blocked` events
- [x] Extract weak categories uit eval result
- [x] Create LoopService goal met `type: 'governance_improvement'`
- [x] Link goal aan GymGovernanceCurriculum phase voor weak categories
- [x] Implementeer re-eval trigger bij goal completion
- [x] Escalate naar human review na 3 failed improvement cycles

**Validation:** Blocked deploy → goal created → re-eval triggered → approve bij verbetering
**Rollback:** `GOVERNANCE_AUTO_IMPROVEMENT_ENABLED=false`

### Task 3.3: Compliance Audit Trail
**Files:** `packages/server/src/services/compliance-audit-service.ts` (uitbreiden)
- [x] Voeg `governance_check` event type toe aan audit log
- [x] Chain governance checks cryptographically (SHA-256 van vorige hash + huidige data)
- [x] Implementeer `getGovernanceAuditTrail(agentId)` — alle governance events
  in chronologische volgorde met chain verification
- [x] Dashboard widget: governance audit trail viewer

**Validation:** Audit trail verification: chain integrity test groen
**Rollback:** Audit entries zijn append-only — geen rollback nodig, alleen stoppen met schrijven

### Task 3.4: Dashboard Governance Intelligence
**Files:** `packages/server/src/routes/advanced.ts` of nieuwe route, dashboard React component
- [x] Endpoint: `GET /api/governance/intelligence/:agentId` — category trends,
  degradation alerts, improvement velocity
- [x] SQL query met window functions voor trend detection per category
- [x] SSE stream voor live governance status tijdens eval-runs
- [x] Dashboard page (React): governance trend chart + category heatmap

**Validation:** Intelligence endpoint retourneert correcte trend data
**Rollback:** Route verwijderen uit `routes/index.ts`

---

## Dependencies Between Tasks

```
1.1 ──→ 1.2 ──→ 1.3 ──→ 1.4
                  │
                  ▼
            2.1 ──→ 2.2 ──→ 2.3
                          │
                          ▼
                    3.1 ──→ 3.2 ──→ 3.3 ──→ 3.4
```

Wave 1 is standalone-deliverable. Wave 2 bouwt op 1.3 (events).
Wave 3 bouwt op 2.2 (discrimination data) + 1.4 (guard fix).
