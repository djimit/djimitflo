## Why

DjimFlo v8.4 has achieved a clean build (494 passing tests) but 953 pre-existing test failures remain. The codebase has 177 services with 107 untested, LoopService is still 4516 LOC, and the test infrastructure has a fundamental flaw: tests using `runMigrations(db)` fail because migration order depends on tables that don't exist yet in isolated test databases.

This change implements a **complete platform hardening** through 4 phases:

1. **Test Infrastructure Fix** — Make all tests runnable by fixing DB setup
2. **Core Service Hardening** — Fix the 50 highest-impact issues
3. **Coverage Expansion** — Bring test coverage from 41% to >80%
4. **Validation & Ship** — Zero new failures, clean build

## What Changes

### Phase 1 — Test Infrastructure (Foundation)
- Create `test-helpers.ts` with complete DB schema for tests
- Fix migration ordering for isolated test DBs
- Add `beforeEach` setup that works for all service tests

### Phase 2 — Core Service Hardening
- Fix LoopService failure metadata recording
- Fix BackgroundWorkerService defensive programming
- Fix runtime contract cache eviction
- Add missing database indexes
- Harden all error paths

### Phase 3 — Coverage Expansion
- Generate tests for top-50 untested services
- Create integration test for core loop lifecycle
- Add API route tests for all endpoints

### Phase 4 — Validation
- Full test suite: 0 new failures
- Build: clean
- Type-check: clean
- Lint: clean

## Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| **Tests passing** | 494 | >1200 |
| **Tests failing** | 953 | <100 |
| **Test coverage** | 41% | >80% |
| **LoopService LOC** | 4516 | <2000 |
| **Build** | clean | clean |
| **Type-check** | clean | clean |
