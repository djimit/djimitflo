## Why

DjimFlo v8.5 heeft 610 passing tests maar 837 failures blijven bestaan. De v8.5 aanpak fixte de test infrastructuur maar raakte de dieperliggende architecturale problemen niet:

**Kritieke issues:**
1. **LoopService 4516 LOC** — #1 God Class met 178 graph connections, tegenover gesteld tot "decompositie in v9.0"
2. **837 test failures** — meer dan de helft van de testsuite faalt nog steeds
3. **ApiClient 1502 LOC** — monolithische dashboard client, #2 grootste file
4. **SwarmIntelligenceService 2010 LOC** — #3 God Class
5. **Test coverage ~55%** — 107 services ongetest
6. **Geen end-to-end integratie test** — core flow (start → continue → execute → verify → complete) niet getest

**Root cause analyse:**
- De 837 failures komen uit ~40 test files die `runMigrations(db)` gebruiken in `beforeEach`
- Deze migraties falen omdat tabellen niet in de juiste volgorde worden aangemaakt
- De `createTestDb()` helper uit v8.5 fixte 17 files maar niet alle 40+
- God Classes maken het onmogelijk om geïsoleerde unit tests te schrijven

## What Changes

### Fase 1 — God Class Decomposition
- **LoopService → 4 services**: LoopOrchestrationService, LoopExecutionService, LoopVerificationService, LoopBudgetService (al bestaat)
- **ApiClient → ApiClient + ApiTypes + ApiHooks**: Splits type definitions en React hooks
- **SwarmIntelligenceService → 3 services**: MissionService, CapabilityService, SpecialistService

### Fase 2 — Test Failure Elimination
- Fix alle 40+ test files die runMigrations gebruiken
- Maak test-db.ts compleet met ALLE tabellen uit productie
- Fix specifieke test failures (auth, authorization, loop-service, worktree, etc.)

### Fase 3 — Test Coverage Expansion
- Schrijf tests voor top-50 untested services
- Maak integration test voor complete loop lifecycle
- Target: >80% coverage

### Fase 4 — Validatie
- Tests passing: >1200
- Tests failing: <50
- Build: clean
- Type-check: clean
- Lint: clean

## Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| **Tests passing** | 610 | >1200 |
| **Tests failing** | 837 | <50 |
| **LoopService LOC** | 4516 | <1500 |
| **ApiClient LOC** | 1502 | <500 |
| **Test coverage** | ~55% | >80% |
| **God Classes >1000 LOC** | 5 | 0 |
