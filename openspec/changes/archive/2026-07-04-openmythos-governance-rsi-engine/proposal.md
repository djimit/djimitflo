## Why

De bestaande OpenMythos-integratie in Djimitflo (level19) is geïmplementeerd maar
architecturaal losgekoppeld van Djimitflo's krachtige bestaande infrastructuur:

1. **OpenMythosEvalService** (359 regels) heeft een eigen `judgeResponse()` die niets
   weet van Djimitflo's `JudgeService` (4-dimensie scoring, contradiction detection,
   verification status). Dubbele judge-logic.

2. **Eval-loop is serieel** (`for (const testCase of cases)`) terwijl `WorkerPool`
   (concurrency-limited, retry, timeout) al bestaat in Djimitflo.

3. **Geen real-time feedback** — evaluaties draaien in stilte. `SwarmEventBus` bestaat
   maar wordt niet gebruikt voor eval events.

4. **GymGovernanceCurriculum** kan niet promoveren naar fase 4 omdat `value-alignment`
   100% dead cases bevat (discrimination report). Data-driven corpus-evolutie ontbreekt.

5. **Geen gesloten RSI-loop** — eval resultaten triggeren geen automatische
   verbetering. De bestaande `evolve.py` genereert goals die nergens naartoe gaan.

Dit plan verbindt de twee systemen op het juiste architecturniveau: OpenMythos als
governance-detectineuron in Djimitflo's zenuwstelsel.

## What Changes

### Wave 1: Refactor naar Bestaande Infra
- `OpenMythosEvalService.judgeResponse()` → delegate naar `JudgeService.evaluate()`
  met governance-specifieke ExpertAnswer mapping
- `for-loop` → `WorkerPool.execute()` met concurrency=10, timeout=120s, retries=2
- Elke case-completion → `swarmEventBus.emit('eval:case:complete', {...})`
- Eval resultaten → `swarmEventBus.emit('eval:run:complete', {...})`

### Wave 2: Data-Driven Corpus Evolutie
- `evolve.py --goal-batch` output → JSON bridge → Djimitflo `LoopService.createGoal()`
- Dead-case detection (discrimination < 0.3) → auto-cut uit curriculum
- Discrimination-gate: alleen cases met spread >= 1 blijven in rotation
- Automatische re-run van discrimination na elke N eval-runs

### Wave 3: Governance-Gated RSI Pipeline
- Agent wijziging → `GovernanceGuardService.runBenchmarkCheck()` (bestaand, uit te breiden)
- Score < 3.0 → BLOCK + auto-create improvement goal via `LoopService`
- Improvement goal → `GymGovernanceCurriculum.runPhaseEvaluation()` op zwakke categories
- Re-eval → gesloten loop tot score >= 4.0
- Compliance audit trail: elke governance check wordt gelogd met cryptographic chaining

## Non-Goals

- Geen wijziging aan OpenMythos Python scripts (benchmark blijft onaangetast)
- Geen nieuwe npm dependencies
- Geen multi-model judge consensus in Wave 1 (single judge, maar via JudgeService)
- Geen real-time governance monitoring buiten eval-runs
- Geen wijziging aan Djimitflo's database schema (bestaande tabellen voldoen)
- Geen productie-deploy van de benchmark zelf

## Security Impact

**Medium.** Governance guard blokkeert deployment — een fout-positief blokkeert
legitieme deploys. Mitigatie: human-review queue tussen block en auto-deploy, met
escalation naar admin na 24u.

Geen nieuwe auth-wijzigingen. Geen nieuwe externe API-calls (Ollama blijft intern).
Bestaande JWT-auth op /api/openmythos/* routes blijft gelden.

## Privacy Impact

**Low.** Eval prompts gaan naar lokale Ollama (workstation). Geen PII in benchmark
cases. Eval results (scores) worden in SQLite opgeslagen op de Djimitflo instance.

## Threat Model Delta

**Nieuw threat surface:**
- Eval-service accepteert agent IDs — injection via agentId parameter mogelijk
  → Mitigatie: input validation (UUID format check)
- Governance scores worden autoriteit voor deployment — manipulatie van scores
  → Mitigatie: scores worden binnen de service berekend, niet ingevoerd
- SwarmEventBus events bevatten eval data — information leakage via SSE
  → Mitigatie: events bevatten alleen caseId + score, niet de prompt/response content

## Success Criteria

- Eval-run van 275 cases voltooit in < 15 minuten (vs >2h serieel)
- Dashboard toont real-time case completion via WebSocket
- Governance guard blokkeert deployment bij score < 3.0 met audit trail
- Eval resultaten triggeren automatische improvement goals bij failure
- Discrimination gate houdt dead-case rate < 15%
- 100% bestaande test suite blijft groen
- Geen nieuwe npm dependencies

## Impact

- **Affected packages:** `@djimitflo/server` (services, routes)
- **New dependencies:** Geen
- **Database:** Geen schema-wijzigingen (bestaande `openmythos_eval_runs`,
  `openmythos_case_results`, `agent_eval_runs` tabellen)
- **External:** Geen wijzigingen (Ollama op workstation)
- **Risk:** Medium
- **Estimated effort:** 12-16 hours across 3 waves
