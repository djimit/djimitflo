# Level-15: Recursive Self-Improvement Engine

## Why

DjimFlo Level-14 heeft een werkende Expert Swarm, Judge, en Worker Pool. Maar het systeem kan **nog niet daadwerkelijk zijn eigen code verbeteren**. De huidige `ControlLoopSelfModificationService` is statisch — het maakt proposals maar voert ze niet uit.

State-of-the-art (Anthropic Juni 2026 "When AI Builds Itself", ICLR 2026 RSI Workshop) toont dat echte RSI vereist:
```
analyze() → propose() → simulate() → deploy() → measure() → rollback || promote
```

DjimFlo's huidige lus stopt bij `propose()`. Dit plan sluit de lus.

## Validatie Door Experts

**Critic review** (architectuur):
- G105 (Skill Composition) onuitvoerbaar — skipped
- G107 (Meta-Learning) overlapt met bestaande services — geconsolideerd
- Eerst LoopService refactoring, dan causal model, dan deployment
- Sandbox/simulatie laag essieel voor veilige A/B testen

**Security review** (safety):
- Immutable audit log voor elke self-modification
- Mutation budget (max N/dag)
- Capability freeze voor security guards
- Dual-approve voor code-mutatie
- Kill switch

## What Changes

### G103: LoopService Refactoring (PRIORITEIT 1)
**Doel**: Splits de 5717-regelige LoopService in domain services.

**Bestaande code hergebruiken**: `SelfCodeAnalysisService` heeft al `architecturalIssues`-detectie.

**Deliverables**:
- Identificeer 3-5 extractable domain services (planning, execution, budget, governance)
- Genereer refactoring proposals via bestaande `ControlLoopSelfModificationService`
- Sandbox test: elke refactor eerst in geïsoleerde worktree
- Metingen: LOC per service, test coverage, blast radius

**Tests**: 15+

### G106: Causal Self-Model (PRIORITEIT 2)
**Doel**: Upgrade bestaande `CausalInferenceService` met interventie-logging.

**Niet een nieuwe service** — uitbreiding van bestaande (`+150 LOC`).

**Deliverables**:
- Interventie logboek: (configuratie_wijziging → uitkomst) paren
- "Wat als?" query interface
- Confounding detectie
- Counterfactual reasoning voor gemaakte keuzes

**Tests**: 12+

### G104: Emergent Specialization (PRIORITEIT 3)
**Doel**: Dynamische agent specialisatie gebaseerd op performance.

**Consolideert**: Bestaande `MetaEvolutionService` pruning + `CompetenceAwarenessService`.

**Deliverables**:
- Performance matrix: (agent, domain, sub-domein) → success rate
- Automatische sub-domein creatie bij herhaald succes (≥3 runs, ≥80% success)
- Pruning van ineffectieve specialisaties (<20% success over 10 runs)
- Cross-domein transfer detectie

**Tests**: 12+

### G101: Skill Evolution (PRIORITEIT 4)
**Doel**: Skills verbeteren op basis van execution resultaten.

**Consolideert**: Bestaande `SkillDistillationService` + `SkillMarketplaceService`.

**Deliverables**:
- Post-run skill analyse: vergelijk procedure met outcome
- Improvement proposals bij herhaalde failures
- Skill frontmatter updates (version, success_rate, last_updated)
- Rate limiting: max 1 skill mutatie per review cycle

**Tests**: 10+

### G105: Safety & Governance Layer (PRIORITEIT 5)
**Doel**: De beveiligers beveiligen.

**Deliverables**:
- Immutable audit log (append-only table)
- Mutation budget: max 5 self-modifications per dag
- Capability freeze: security/auth/audit code immutable
- Dual-approve voor code-mutatie (twee reviewers)
- Kill switch: harde stop voor alle self-modification
- Drift detection: halt bij model-gedrag afwijking

**Tests**: 15+

### G107: Integration + Validation (PRIORITEIT 6)
**Doel**: Alles aan elkaar koppelen en valideren.

**Deliverables**:
- Server startup: initialiseer alle nieuwe services
- REST API: expert swarm (uitgebreid), causal queries, review queue
- Autonomous cycle: weekly expert swarm + daily meta-evolution
- Full test suite: ≥ 74 new tests
- Production proof: end-to-end RSI cycle

## Non-Goals

- Geen volledige zelf-replicatie (ethisch onverantwoord)
- Geen modificatie van governance laag zonder human approval
- Geen oneindige recursie (max depth = 3)
- Geen externe code modificatie (alleen eigen codebase)

## Safety Guards (Verplicht)

| Guard | Implementatie |
|-------|--------------|
| Immutable audit log | Append-only `rsi_audit_log` table |
| Mutation budget | Max 5 self-modifications per dag |
| Capability freeze | Security/auth/audit code immutable |
| Dual-approve | Twee onafhankelijke reviewers |
| Kill switch | Feature flag `RSI_ENABLED=false` |
| Drift detection | Halt bij model-gedrag afwijking > 20% |
| Sandbox testing | Elke refactor eerst in geïsoleerde worktree |

## Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| LoopService LOC | 5717 | < 4000 |
| Services with skills | 0 | All expert workers |
| Causal predictions | N/A | ≥ 60% accuracy |
| Emergent specializations | 0 | ≥ 3 |
| Skill improvements | 0 | ≥ 1/week |
| Self-modifications | 0 | ≥ 2/week |
| Security incidents | 0 | 0 |
| Tests | 990 | 1064+ |
