# Level-14: Scalable Expert Swarm — Skill-Driven Parallel Knowledge Evolution

## Why

Level-13 heeft een werkende Expert Swarm Orchestrator, maar de sub-agents worden **niet gestuurd met skills**. Elke worker krijgt dezelfde generic prompt, ongeacht zijn domein. Daarnaast:

- Sub-agents worden sequentieel verwerkt in chunks (geen echte parallelisatie)
- Judge verdicts gaan direct naar graph zonder human-in-the-loop
- Knowledge wordt opgeslagen maar de OKF graph wordt niet geüpdatet
- Skills worden niet verbeterd op basis van execution resultaten

## Thesis

Door bestaande services correct te koppelen creëren we een **schijfbaar expert swarm systeem** dat:
1. Elke sub-agent stuurt met een **skill** (procedure) + **knowledge source** (adapter)
2. Workers draaien **parallel** via een worker pool met configurable concurrency
3. Judge verdicts bieden **human-in-the-loop** bij onzekerheid
4. Knowledge graph wordt **automatisch geüpdatet** bij verified knowledge
5. Skills **evolueren** op basis van execution resultaten

## What Changes

### G97: Skill-Driven Expert Workers
- Update `ExpertSwarmOrchestrator` om `SkillService.getSkillForFinding()` te gebruiken
- Elke sub-agent prompt bevat nu: skill procedure + domain + source
- Skill wordt geïnjecteerd als context in de maker assignment

### G98: Worker Pool
- Nieuwe `WorkerPool` service met configurable concurrency
- Queue-based work distribution
- Automatic retry bij failure (max 2 retries)
- Health monitoring per worker

### G99: Judge Human-in-the-Loop
- Judge verdicts met score 60-79 → pending human review
- Score ≥ 80 → auto-approve
- Score < 60 → rejected met reasoning
- Integratie met `OperatorInterventionService` voor review queue

### G100: OKF Knowledge Graph Update
- Automatische OKF concept creatie bij verified knowledge
- Frontmatter met bronnen, confidence, verification status
- Update bestaande concepten bij nieuw bewijs
- Link naar arXiv ID, Wikipedia URL

### G101: Skill Evolution
- Post-run skill analyse: vergelijk procedure met outcome
- Genereer skill improvement proposals bij herhaalde failures
- Update skill frontmatter bij bewezen verbeteringen
- Automatische promotie van candidate skills naar validated

### G102: Integration + Validation
- Server startup: initialiseer WorkerPool + OKF integration
- REST API: POST /swarms/expert/dispatch (uitgebreid), GET /swarms/expert/review
- Autonomous cycle: expert swarm draait wekelijks
- Full test suite: ≥ 40 new tests
- Production proof: end-to-end expert swarm run

## Execution Order

```
G97 (Skill Workers) → G98 (Worker Pool) → G99 (Human-Loop)
                                               ↓
G102 (Integration) ← G101 (Skill Evolution) ← G100 (OKF Update)
```

## Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| Expert workers with skills | 0 | 3+ per domain |
| Parallel workers | 3 | 10+ |
| Judge auto-approve rate | 0% | ≥ 40% |
| OKF knowledge updates | 0 | ≥ 1 per swarm |
| Skill improvements | 0 | ≥ 1 per week |
| Tests | 990 | 1030+ |
