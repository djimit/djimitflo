# Level-17: Central Memory System + Skill Evolution Gym

## Why

DjimFlo Level-16 heeft 100 services en 1050+ tests, maar mist twee fundamentele AGI-capabilities:

1. **Geen centraal memory system** — memory is verspreid over autobiographical, cognitive, elastic, en autobiographical stores. Er is geen canonical namespace voor agent turns.
2. **Geen skill evolution** — skills worden gedistilleerd maar nooit geëvolueerd op basis van traces, prompt patterns, of exploration.

Daarnaast is de LoopService facade (5717 LOC) nog niet herschreven om de 3 nieuwe planning/execution/governance services te gebruiken.

## Thesis

Door een centraal memory system te bouwen, skill evolution gym te implementeren, en de LoopService facade te refactoren, wordt DjimFlo een **zichzelf verbeterend AGI-systeem** met:
- Canonical memory namespace (episodes, skills, relations, projections)
- Trace-gedreven skill evolutie met prompt pattern registry
- A2A agent cards voor memory-aware handoffs
- Gerefactorde LoopService (< 2000 LOC)

## What Changes

### G120: MemoryStore Abstraction
- Interface met `store()`, `retrieve()`, `search()`, `relate()`, `project()`
- In-memory implementatie voor testing
- Postgres implementatie voor productie (deferred)
- Integratie met bestaande memory services

### G121: MemoryCurator
- Raw episodes → structured memories
- Deduplicatie en consolidatie
- Confidence scoring per memory
- Integratie met autobiographical + cognitive memory

### G122: LoopService Facade Refactor
- Herschrijf LoopService om G108-G110 services te gebruiken
- Van 5717 naar < 2000 LOC
- Alle bestaande tests blijven werken

### G123: SkillPatternMiner
- Extract patterns uit swarm episodes
- Cross-episode pattern detection
- Candidate skill generatie met source evidence

### G124: PromptPatternRegistry
- Prompt templates met before/after evaluation
- Trace-driven prompt optimization
- Per-domain prompt selection

### G125: A2AAgentRegistry
- Agent cards met capabilities, memory scope, trust level
- Memory-aware handoff protocol
- Lightweight A2A discovery

### G126: Skill Evolution Gym
- Exploration suite met evaluator
- Online resource ingestion
- Skill trigger optimization

## Execution Order

```
G120 (MemoryStore) → G121 (MemoryCurator) → G122 (Facade Refactor)
                 ↓
G123 (PatternMiner) → G124 (PromptRegistry) → G125 (A2ARegistry) → G126 (Gym)
                 ↓
G127 (Ship)
```

## Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| LoopService LOC | 5717 | < 2000 |
| Memory stores | 4 verspreid | 1 canonical + 4 legacy |
| Skill evolution | 0 | 1 gym with evaluator |
| A2A capability | FederationTrustManager | + Agent Cards |
| Tests | 1050 | 1120+ |
